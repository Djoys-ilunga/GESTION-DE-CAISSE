use crate::{
    model::*,
    state::{millis, Clock, Session, State, Verifier},
    Error, Result,
};
use reqwest::{Client, Method, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use uuid::Uuid;
use zeroize::Zeroizing;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginResponse {
    access_token: String,
    profile: Profile,
}
pub struct Broker {
    client: Client,
    base: Url,
    deployment: String,
    device: Uuid,
    state: Arc<Mutex<State>>,
    clock: Clock,
}
impl Broker {
    pub async fn cash_catalog(&self, expected: Option<u64>) -> Result<Value> {
        let (generation, _) = self.snapshot(true, false, expected)?;
        let online = {
            let state = self.state()?;
            let s = state.session.as_ref().ok_or(Error::AuthRequired)?;
            s.permission("ledger:read")?;
            s.online
        };
        if online {
            let data = self
                .protected(Method::GET, "cash/registers", None, Some(generation))
                .await?;
            let now = self.clock.now();
            if !data.get("items").is_some_and(Value::is_array)
                || millis(
                    data.get("synchronizedAt")
                        .and_then(Value::as_str)
                        .ok_or(Error::InvalidResponse)?,
                )? > now + 30000
            {
                return Err(Error::InvalidResponse);
            }
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.guard(now)?;
            s.cash_catalog = Some(data.clone());
            return Ok(json!({"data":data,"stale":false}));
        }
        let state = self.state()?;
        Self::generation(&state, Some(generation))?;
        let s = state.session.as_ref().ok_or(Error::AuthRequired)?;
        s.guard(self.clock.now())?;
        let data = s.cash_catalog.as_ref().ok_or(Error::Unavailable)?;
        if self.clock.now()
            >= millis(
                data.get("expiresAt")
                    .and_then(Value::as_str)
                    .ok_or(Error::Expired)?,
            )?
        {
            return Err(Error::Expired);
        }
        Ok(json!({"data":data,"stale":true}))
    }
    fn query_path(base: &str, payload: &Value, allowed: &[&str]) -> Result<String> {
        let object = payload.as_object().ok_or(Error::InvalidInput)?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(Error::InvalidInput);
        }
        let mut url = Url::parse("https://query.invalid/").map_err(|_| Error::InvalidInput)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in object {
                if value.is_null() {
                    continue;
                }
                let value = match value {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => return Err(Error::InvalidInput),
                };
                if value.len() > 300 {
                    return Err(Error::InvalidInput);
                }
                if !value.is_empty() {
                    pairs.append_pair(key, &value);
                }
            }
        }
        Ok(format!("{base}?{}", url.query().unwrap_or_default()))
    }
    fn mark_receipt(state: &mut State, value: &Value) -> Result<()> {
        let client = Uuid::parse_str(
            value
                .get("clientDraftId")
                .and_then(Value::as_str)
                .ok_or(Error::InvalidResponse)?,
        )
        .map_err(|_| Error::InvalidResponse)?;
        let id = Uuid::parse_str(
            value
                .get("id")
                .and_then(Value::as_str)
                .ok_or(Error::InvalidResponse)?,
        )
        .map_err(|_| Error::InvalidResponse)?;
        let number = value
            .get("number")
            .and_then(Value::as_str)
            .filter(|v| v.starts_with("REC-") && v.len() <= 160)
            .ok_or(Error::InvalidResponse)?;
        let version = value
            .get("version")
            .and_then(Value::as_u64)
            .ok_or(Error::InvalidResponse)?;
        let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
        let mut changed = false;
        if let Some(record) = s.drafts.get_mut(&client) {
            changed = record.state != "confirmed" || record.confirmed_receipt_id != Some(id);
            if u64::from(record.version) != version {
                s.drafts.remove(&client);
            } else {
                record.state = "confirmed".into();
                record.confirmed_receipt_id = Some(id);
                record.receipt_number = Some(number.into());
                record.result = None;
            }
        }
        if changed {
            s.balances = None;
            s.cash_catalog = None;
        }
        Ok(())
    }
    pub async fn cash_action(
        &self,
        action: &str,
        payload: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        let (generation, _) = self.snapshot(true, true, expected)?;
        let payload = payload.unwrap_or_else(|| json!({}));
        let permission = match action {
            "configuration" | "create-agency" | "create" | "update" => "cash:configure",
            "open" => "session:manage",
            "pending" | "restore" => "draft:read_own",
            "confirm" => "receipt:post",
            "history" | "receipt" | "evidence" => "receipt:read",
            _ => return Err(Error::Forbidden),
        };
        {
            self.state()?
                .session
                .as_ref()
                .ok_or(Error::AuthRequired)?
                .permission(permission)?;
        }
        let id = || -> Result<Uuid> {
            Uuid::parse_str(
                payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)
        };
        let (method, path, body) = match action {
            "configuration" => (Method::GET, "cash/configuration".into(), None),
            "create-agency" => (Method::POST, "cash/agencies".into(), Some(payload.clone())),
            "create" => (Method::POST, "cash/registers".into(), Some(payload.clone())),
            "update" => (
                Method::PUT,
                format!("cash/registers/{}", id()?),
                Some(payload.get("data").ok_or(Error::InvalidInput)?.clone()),
            ),
            "open" => (Method::POST, format!("cash/registers/{}/open", id()?), None),
            "pending" => (
                Method::GET,
                Self::query_path("cash/drafts", &payload, &["page"])?,
                None,
            ),
            "restore" => (Method::GET, format!("cash/drafts/{}", id()?), None),
            "history" => (
                Method::GET,
                Self::query_path(
                    "cash/receipts",
                    &payload,
                    &[
                        "page",
                        "cashRegisterId",
                        "currency",
                        "category",
                        "search",
                        "from",
                        "to",
                    ],
                )?,
                None,
            ),
            "receipt" => (Method::GET, format!("cash/receipts/{}", id()?), None),
            "evidence" => (
                Method::GET,
                format!("cash/receipts/{}/evidence", id()?),
                None,
            ),
            "confirm" => {
                if payload.get("received") != Some(&Value::Bool(true))
                    || !payload
                        .get("expectedVersion")
                        .and_then(Value::as_u64)
                        .is_some_and(|v| v > 0 && v <= u32::MAX.into())
                {
                    return Err(Error::InvalidInput);
                }
                self.revalidate(Some(generation)).await?;
                self.state()?
                    .session
                    .as_ref()
                    .ok_or(Error::AuthRequired)?
                    .permission("receipt:post")?;
                (
                    Method::POST,
                    format!("cash/drafts/{}/confirm", id()?),
                    Some(json!({"expectedVersion":payload["expectedVersion"],"received":true})),
                )
            }
            _ => return Err(Error::Forbidden),
        };
        let value = self
            .protected(method, &path, body, Some(generation))
            .await?;
        let now = self.clock.now();
        let mut state = self.state()?;
        Self::generation(&state, Some(generation))?;
        state
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .guard(now)?;
        if action == "confirm" {
            if value.get("sourceDraftId") != payload.get("id") {
                return Err(Error::InvalidResponse);
            }
            Self::mark_receipt(&mut state, &value)?;
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.balances = None;
            s.cash_catalog = None;
        } else if action == "pending" {
            for row in value
                .get("items")
                .and_then(Value::as_array)
                .ok_or(Error::InvalidResponse)?
            {
                if !row.get("receiptId").is_none_or(Value::is_null) {
                    Self::mark_receipt(
                        &mut state,
                        &json!({"id":row["receiptId"],"number":row["receiptNumber"],"clientDraftId":row["clientDraftId"],"version":row["version"]}),
                    )?;
                }
            }
        } else if action == "restore" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Remote {
                client_draft_id: Uuid,
                agency_id: Uuid,
                cash_register_id: Uuid,
                version: u32,
                currency: String,
                amount: String,
                description: String,
                receipt_details: Option<ReceiptDetails>,
            }
            let remote: Remote =
                serde_json::from_value(value).map_err(|_| Error::InvalidResponse)?;
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            if let Some(old) = s.drafts.get(&remote.client_draft_id) {
                if millis(&old.draft.expires_at)? > now {
                    if old.state == "synced" && old.version == remote.version {
                        return serde_json::to_value(old).map_err(|_| Error::InvalidResponse);
                    }
                    return Err(Error::Conflict);
                }
            }
            let input = SaveDraft {
                draft: Draft {
                    id: remote.client_draft_id,
                    kind: "receipt".into(),
                    currency: remote.currency,
                    amount: remote.amount,
                    description: remote.description,
                    created_at: crate::state::iso(now),
                    expires_at: crate::state::iso((now + 900000).min(s.absolute_until)),
                    receipt_details: remote.receipt_details,
                },
                agency_id: remote.agency_id,
                cash_register_id: Some(remote.cash_register_id),
                expected_version: None,
            };
            let mut record = s.save_draft(input, now)?;
            if remote.version == 0 {
                return Err(Error::InvalidResponse);
            }
            record.version = remote.version;
            record.server_version = Some(remote.version);
            record.state = "synced".into();
            s.drafts.insert(record.draft.id, record.clone());
            return serde_json::to_value(record).map_err(|_| Error::InvalidResponse);
        }
        Ok(value)
    }
    pub fn new(
        base: &str,
        deployment: &str,
        device: Uuid,
        allow_debug_loopback: bool,
    ) -> Result<Self> {
        let url = Url::parse(base).map_err(|_| Error::InvalidInput)?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || deployment.is_empty()
            || !(url.scheme() == "https"
                || (allow_debug_loopback && url.scheme() == "http" && loopback))
        {
            return Err(Error::Identity);
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| Error::Unavailable)?;
        Ok(Self {
            client,
            base: url,
            deployment: deployment.into(),
            device,
            state: Arc::new(Mutex::new(State::default())),
            clock: Clock::default(),
        })
    }
    fn generation(state: &State, expected: Option<u64>) -> Result<()> {
        if expected.is_some_and(|v| v != state.generation) {
            Err(Error::SessionChanged)
        } else {
            Ok(())
        }
    }
    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| Error::Unavailable)
    }
    pub fn status(&self) -> Result<SessionView> {
        Ok(self.state()?.view(self.clock.now()))
    }
    async fn raw(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value> {
        let url = self
            .base
            .join(&format!("api/v1/{path}"))
            .map_err(|_| Error::InvalidInput)?;
        let mut request = self
            .client
            .request(method, url)
            .header("Cache-Control", "no-store")
            .header("X-CaissePro-Device", self.device.to_string());
        if let Some(token) = token {
            request = request.bearer_auth(token)
        }
        if let Some(body) = body {
            request = request.json(&body)
        }
        let mut response = request.send().await.map_err(|_| Error::Unavailable)?;
        match response.status().as_u16() {
            200..=299 => {}
            401 => return Err(Error::Credentials),
            403 => return Err(Error::Forbidden),
            409 => return Err(Error::Conflict),
            423 => return Err(Error::Locked),
            429 => return Err(Error::Throttled),
            400..=499 => return Err(Error::InvalidInput),
            _ => return Err(Error::Unavailable),
        }
        if response
            .content_length()
            .is_some_and(|size| size > 2_000_000)
        {
            return Err(Error::InvalidResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
            if bytes.len().saturating_add(chunk.len()) > 2_000_000 {
                return Err(Error::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)
    }
    async fn health(&self) -> Result<()> {
        let health = self.raw(Method::GET, "health/ready", None, None).await?;
        if health.get("service").and_then(Value::as_str) != Some("caissepro-api")
            || health.get("status").and_then(Value::as_str) != Some("ready")
            || health.get("protocolVersion").and_then(Value::as_u64) != Some(1)
            || health.get("deploymentId").and_then(Value::as_str) != Some(&self.deployment)
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub async fn check_health(&self) -> Result<Value> {
        self.health().await?;
        Ok(
            json!({"service":"caissepro-api","protocolVersion":1,"deploymentId":self.deployment,"status":"ready"}),
        )
    }
    pub async fn tick(&self) -> Result<SessionView> {
        let should_lock = {
            let state = self.state()?;
            state
                .session
                .as_ref()
                .filter(|s| s.online && !s.locked && self.clock.now() - s.last_activity >= 300_000)
                .map(|_| state.generation)
        };
        if let Some(generation) = should_lock {
            let _ = self.lock(Some(generation)).await;
        }
        self.status()
    }
    fn snapshot(
        &self,
        unlocked: bool,
        online: bool,
        expected: Option<u64>,
    ) -> Result<(u64, Zeroizing<String>)> {
        let mut state = self.state()?;
        Self::generation(&state, expected)?;
        let _ = state.view(self.clock.now());
        let session = state.session.as_ref().ok_or(Error::AuthRequired)?;
        if unlocked {
            session.guard(self.clock.now())?;
        }
        if online && !session.online {
            return Err(Error::OnlineRequired);
        }
        Ok((state.generation, session.token.clone()))
    }
    fn fail(&self, generation: u64, error: &Error) -> Result<()> {
        let mut state = self.state()?;
        if state.generation != generation {
            return Err(Error::SessionChanged);
        }
        match error {
            Error::Credentials | Error::Identity | Error::Expired | Error::InvalidResponse => {
                state.clear("SESSION_REVOKED")
            }
            Error::Unavailable => {
                if let Some(s) = state.session.as_mut() {
                    if s.online {
                        s.locked = true;
                    }
                    s.online = false;
                    s.revalidating = false;
                }
                state.reason = Some("OFFLINE_UNLOCK_REQUIRED".into());
            }
            Error::Locked => {
                if let Some(s) = state.session.as_mut() {
                    s.locked = true;
                    s.revalidating = false;
                }
            }
            _ => {
                if let Some(s) = state.session.as_mut() {
                    s.revalidating = false;
                }
            }
        }
        Ok(())
    }
    pub async fn login(
        &self,
        company_code: String,
        email: String,
        password: Zeroizing<String>,
    ) -> Result<SessionView> {
        if password.is_empty()
            || password.len() > 512
            || company_code.len() > 32
            || email.len() > 254
        {
            return Err(Error::InvalidInput);
        }
        let (generation, previous) = {
            let mut state = self.state()?;
            let previous = state.session.as_ref().map(|s| s.token.clone());
            state.clear("LOGIN_PENDING");
            (state.generation, previous)
        };
        self.health().await?;
        if let Some(token) = previous {
            let _ = self
                .raw(Method::POST, "auth/logout", Some(token.as_str()), None)
                .await;
        }
        let response=self.raw(Method::POST,"auth/login",None,Some(json!({"companyCode":company_code,"email":email,"password":password.as_str(),"deviceId":self.device}))).await?;
        let response: LoginResponse =
            serde_json::from_value(response).map_err(|_| Error::InvalidResponse)?;
        if response.profile.device_id != self.device
            || response.profile.user.email != email.trim().to_lowercase()
            || response.profile.company.code != company_code.trim().to_uppercase()
        {
            return Err(Error::InvalidResponse);
        }
        let token = Zeroizing::new(response.access_token);
        let verifier = if response.profile.offline_until.is_some() {
            let secret = password;
            Some(
                tokio::task::spawn_blocking(move || Verifier::create(secret.as_str()))
                    .await
                    .map_err(|_| Error::Unavailable)??,
            )
        } else {
            None
        };
        let stale = { self.state()?.generation != generation };
        if stale {
            let _ = self
                .raw(Method::POST, "auth/logout", Some(token.as_str()), None)
                .await;
            return Err(Error::SessionChanged);
        }
        let session = Session::new(token, response.profile, verifier, self.clock.now())?;
        let mut state = self.state()?;
        if state.generation != generation {
            return Err(Error::SessionChanged);
        }
        state.session = Some(session);
        state.reason = None;
        Ok(state.view(self.clock.now()))
    }
    pub async fn logout(&self, expected: Option<u64>) -> Result<SessionView> {
        let token = {
            let mut state = self.state()?;
            Self::generation(&state, expected)?;
            let token = state.session.as_ref().map(|s| s.token.clone());
            state.clear("LOGGED_OUT");
            token
        };
        if let Some(token) = token {
            let _ = self
                .raw(Method::POST, "auth/logout", Some(token.as_str()), None)
                .await;
        }
        self.status()
    }
    pub async fn lock(&self, expected: Option<u64>) -> Result<SessionView> {
        let (generation, token) = self.snapshot(false, false, expected)?;
        {
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            if let Some(s) = state.session.as_mut() {
                s.locked = true;
                s.revalidating = false;
            }
            state.reason = Some("SESSION_LOCKED".into());
        }
        let response = self
            .raw(Method::POST, "auth/lock", Some(token.as_str()), None)
            .await;
        if let Err(error) = response {
            self.fail(generation, &error)?;
        }
        self.status()
    }
    pub async fn revalidate(&self, expected: Option<u64>) -> Result<SessionView> {
        let (generation, token) = self.snapshot(false, false, expected)?;
        {
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            if let Some(s) = state.session.as_mut() {
                s.revalidating = !s.online;
            }
        }
        let result = async {
            self.health().await?;
            let value = self
                .raw(Method::GET, "auth/session", Some(token.as_str()), None)
                .await?;
            serde_json::from_value::<Profile>(value).map_err(|_| Error::InvalidResponse)
        }
        .await;
        match result {
            Err(error) => {
                self.fail(generation, &error)?;
                Err(error)
            }
            Ok(profile) => {
                let now = self.clock.now();
                let (offline, absolute) = match Session::validate_profile(&profile, now) {
                    Ok(deadlines) => deadlines,
                    Err(error) => {
                        self.fail(generation, &error)?;
                        return Err(error);
                    }
                };
                let mut state = self.state()?;
                if state.generation != generation {
                    return Err(Error::SessionChanged);
                }
                let session = state.session.as_mut().ok_or(Error::SessionChanged)?;
                if profile.session_id != session.profile.session_id
                    || profile.user.id != session.profile.user.id
                    || profile.company.id != session.profile.company.id
                    || profile.device_id != self.device
                {
                    state.clear("SERVER_IDENTITY_INVALID");
                    return Err(Error::Identity);
                }
                if !profile.same_scope(&session.profile) {
                    session.balances = None;
                    session.cash_catalog = None;
                    session.drafts.clear();
                }
                session.locked = session.locked || profile.locked;
                session.profile = profile;
                session.offline_until = if session.profile.locked && offline == 0 {
                    session.offline_until.min(absolute)
                } else {
                    offline
                };
                session.absolute_until = absolute;
                session.online = true;
                session.revalidating = false;
                state.reason = None;
                Ok(state.view(now))
            }
        }
    }
    pub async fn unlock(
        &self,
        password: Zeroizing<String>,
        expected: Option<u64>,
    ) -> Result<SessionView> {
        if password.is_empty() || password.len() > 512 {
            return Err(Error::InvalidInput);
        }
        let (generation, token) = self.snapshot(false, false, expected)?;
        match self.health().await {
            Ok(()) => {
                let response = self
                    .raw(
                        Method::POST,
                        "auth/unlock",
                        Some(token.as_str()),
                        Some(json!({"password":password.as_str()})),
                    )
                    .await;
                match response {
                    Ok(value) => {
                        let response: LoginResponse = match serde_json::from_value(value) {
                            Ok(response) => response,
                            Err(_) => {
                                self.fail(generation, &Error::InvalidResponse)?;
                                return Err(Error::InvalidResponse);
                            }
                        };
                        let now = self.clock.now();
                        let (offline, absolute) =
                            match Session::validate_profile(&response.profile, now) {
                                Ok(deadlines) => deadlines,
                                Err(error) => {
                                    self.fail(generation, &error)?;
                                    return Err(error);
                                }
                            };
                        let mut state = self.state()?;
                        if state.generation != generation {
                            return Err(Error::SessionChanged);
                        }
                        let s = state.session.as_mut().ok_or(Error::SessionChanged)?;
                        if response.profile.session_id != s.profile.session_id
                            || response.profile.device_id != self.device
                            || response.profile.user.id != s.profile.user.id
                            || response.profile.company.id != s.profile.company.id
                        {
                            state.clear("SERVER_IDENTITY_INVALID");
                            return Err(Error::Identity);
                        }
                        if response.access_token.len() != 43
                            || !response
                                .access_token
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                        {
                            state.clear("SERVER_RESPONSE_INVALID");
                            return Err(Error::InvalidResponse);
                        }
                        if !response.profile.same_scope(&s.profile) {
                            s.balances = None;
                            s.cash_catalog = None;
                            s.drafts.clear();
                        }
                        s.token = Zeroizing::new(response.access_token);
                        s.profile = response.profile;
                        s.offline_until = offline;
                        s.absolute_until = absolute;
                        s.locked = false;
                        s.online = true;
                        s.failures = 0;
                        s.last_activity = now;
                        // Les réponses en vol avec l'ancien jeton ne doivent
                        // pas révoquer ou réexposer la nouvelle session locale.
                        state.generation += 1;
                        state.reason = None;
                        Ok(state.view(now))
                    }
                    Err(Error::Credentials) => {
                        let still_valid = self
                            .raw(Method::GET, "auth/session", Some(token.as_str()), None)
                            .await
                            .is_ok();
                        if !still_valid {
                            self.fail(generation, &Error::Credentials)?;
                            return Err(Error::Credentials);
                        }
                        let mut state = self.state()?;
                        if state.generation != generation {
                            return Err(Error::SessionChanged);
                        }
                        if let Some(s) = state.session.as_mut() {
                            s.failures += 1;
                            if s.failures >= 5 {
                                state.clear("TOO_MANY_ATTEMPTS");
                            }
                        }
                        Err(Error::Credentials)
                    }
                    Err(error) => {
                        self.fail(generation, &error)?;
                        Err(error)
                    }
                }
            }
            Err(Error::Unavailable) => {
                self.fail(generation, &Error::Unavailable)?;
                let state_arc = self.state.clone();
                let now = self.clock.now();
                let secret = password;
                let valid = tokio::task::spawn_blocking(move || {
                    let mut state = state_arc.lock().map_err(|_| Error::Unavailable)?;
                    if state.generation != generation {
                        return Err(Error::SessionChanged);
                    }
                    let session = state.session.as_mut().ok_or(Error::AuthRequired)?;
                    if now >= session.offline_until
                        || now >= session.absolute_until
                        || session.profile.user.must_change_password
                    {
                        return Err(Error::Expired);
                    }
                    session.permission("offline:access")?;
                    let valid = session
                        .verifier
                        .as_ref()
                        .ok_or(Error::Forbidden)?
                        .verify(secret.as_str())?;
                    if !valid {
                        session.failures += 1;
                        if session.failures >= 5 {
                            state.clear("TOO_MANY_ATTEMPTS");
                        }
                    }
                    Ok(valid)
                })
                .await
                .map_err(|_| Error::Unavailable)??;
                if !valid {
                    return Err(Error::Credentials);
                }
                let now = self.clock.now();
                let mut state = self.state()?;
                if state.generation != generation {
                    return Err(Error::SessionChanged);
                }
                let session = state.session.as_mut().ok_or(Error::AuthRequired)?;
                if now >= session.offline_until {
                    return Err(Error::Expired);
                }
                session.locked = false;
                session.online = false;
                session.revalidating = false;
                session.last_activity = now;
                session.failures = 0;
                state.reason = Some("OFFLINE_LIMITED".into());
                Ok(state.view(now))
            }
            Err(error) => {
                self.fail(generation, &error)?;
                Err(error)
            }
        }
    }
    pub async fn activity(&self, expected: Option<u64>) -> Result<SessionView> {
        let now = self.clock.now();
        let send = {
            let mut state = self.state()?;
            Self::generation(&state, expected)?;
            let _ = state.view(now);
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.guard(now)?;
            s.last_activity = now;
            if s.online && now - s.last_activity_sent >= 15_000 {
                s.last_activity_sent = now;
                true
            } else {
                false
            }
        };
        if send {
            let (generation, token) = self.snapshot(true, true, expected)?;
            if let Err(error) = self
                .raw(Method::POST, "auth/activity", Some(token.as_str()), None)
                .await
            {
                self.fail(generation, &error)?;
                return Err(error);
            }
        }
        self.status()
    }
    async fn protected(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        let (generation, token) = self.snapshot(true, true, expected)?;
        let result = self.raw(method, path, Some(token.as_str()), body).await;
        if self.state()?.generation != generation {
            return Err(Error::SessionChanged);
        }
        if let Err(error) = &result {
            self.fail(generation, error)?;
        }
        result
    }
    pub async fn admin(
        &self,
        action: &str,
        payload: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        let (method, path, body) = match action {
            "users" => (Method::GET, "admin/users".to_string(), None),
            "catalog" => (Method::GET, "admin/access".to_string(), None),
            "logs" => (Method::GET, "admin/logs".to_string(), None),
            "create" => (Method::POST, "admin/users".to_string(), payload),
            "access" => {
                let value = payload.ok_or(Error::InvalidInput)?;
                let user = Uuid::parse_str(
                    value
                        .get("userId")
                        .and_then(Value::as_str)
                        .ok_or(Error::InvalidInput)?,
                )
                .map_err(|_| Error::InvalidInput)?;
                (
                    Method::PUT,
                    format!("admin/users/{user}/access"),
                    Some(
                        json!({"access":value.get("access"),"expectedVersion":value.get("expectedVersion")}),
                    ),
                )
            }
            _ => return Err(Error::Forbidden),
        };
        self.protected(method, &path, body, expected).await
    }
    pub async fn change_password(
        &self,
        current: Zeroizing<String>,
        new: Zeroizing<String>,
        expected: Option<u64>,
    ) -> Result<SessionView> {
        let (generation, token) = self.snapshot(false, true, expected)?;
        let result = self
            .raw(
                Method::POST,
                "auth/password",
                Some(token.as_str()),
                Some(json!({"currentPassword":current.as_str(),"newPassword":new.as_str()})),
            )
            .await;
        match result {
            Ok(_) => {
                let mut state = self.state()?;
                if state.generation == generation {
                    state.clear("PASSWORD_CHANGED");
                }
                Ok(state.view(self.clock.now()))
            }
            Err(error) => {
                self.fail(generation, &error)?;
                Err(error)
            }
        }
    }
    pub fn save_draft(&self, input: SaveDraft, expected: Option<u64>) -> Result<DraftRecord> {
        let now = self.clock.now();
        let mut state = self.state()?;
        Self::generation(&state, expected)?;
        let _ = state.view(now);
        state
            .session
            .as_mut()
            .ok_or(Error::AuthRequired)?
            .save_draft(input, now)
    }
    pub fn drafts(&self, expected: Option<u64>) -> Result<Vec<DraftRecord>> {
        let now = self.clock.now();
        let mut state = self.state()?;
        Self::generation(&state, expected)?;
        let _ = state.view(now);
        state
            .session
            .as_mut()
            .ok_or(Error::AuthRequired)?
            .list_drafts(now)
    }
    pub async fn balances(&self, expected: Option<u64>) -> Result<Value> {
        let online = {
            let now = self.clock.now();
            let mut state = self.state()?;
            Self::generation(&state, expected)?;
            let _ = state.view(now);
            let s = state.session.as_ref().ok_or(Error::AuthRequired)?;
            s.guard(now)?;
            s.permission("ledger:read")?;
            s.online
        };
        if online {
            let generation = self.state()?.generation;
            let value = self
                .protected(Method::GET, "workspace/balances", None, expected)
                .await?;
            let now = self.clock.now();
            let synchronized = value
                .get("synchronizedAt")
                .and_then(Value::as_str)
                .ok_or(Error::InvalidResponse)?;
            if millis(synchronized)? > now + 30_000 {
                return Err(Error::InvalidResponse);
            }
            let mut state = self.state()?;
            if state.generation != generation {
                return Err(Error::SessionChanged);
            }
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.guard(now)?;
            s.balances = Some(value.clone());
            return Ok(json!({"data":value,"stale":false}));
        }
        let state = self.state()?;
        Self::generation(&state, expected)?;
        let s = state.session.as_ref().ok_or(Error::AuthRequired)?;
        let value = s.balances.as_ref().ok_or(Error::Unavailable)?;
        let expiry = value
            .get("expiresAt")
            .and_then(Value::as_str)
            .ok_or(Error::Expired)?;
        if self.clock.now() >= millis(expiry)? {
            return Err(Error::Expired);
        }
        Ok(json!({"data":value,"stale":true}))
    }
    pub async fn synchronize(&self, expected: Option<u64>) -> Result<Vec<SyncResult>> {
        let (generation, _) = self.snapshot(true, false, expected)?;
        self.revalidate(Some(generation)).await?;
        let records = self.drafts(Some(generation))?;
        let mut results = Vec::new();
        for record in records
            .into_iter()
            .filter(|r| r.state != "synced" && r.state != "confirmed")
        {
            let _ = self.snapshot(true, true, Some(generation))?;
            let result=self.protected(Method::POST,"workspace/drafts/sync",Some(json!({"draft":record.draft,"agencyId":record.agency_id,"cashRegisterId":record.cash_register_id,"version":record.version,"expectedServerVersion":record.server_version})),Some(generation)).await;
            let response = match result {
                Ok(value) => {
                    let value: SyncResult =
                        serde_json::from_value(value).map_err(|_| Error::InvalidResponse)?;
                    if value.draft_id != record.draft.id
                        || value.outcome != "accepted-as-draft"
                        || value.code != "draft-received"
                    {
                        return Err(Error::InvalidResponse);
                    }
                    value
                }
                Err(Error::Conflict) => SyncResult {
                    draft_id: record.draft.id,
                    outcome: "conflict".into(),
                    code: "conflict".into(),
                },
                Err(Error::Forbidden | Error::InvalidInput) => SyncResult {
                    draft_id: record.draft.id,
                    outcome: "rejected".into(),
                    code: "validation-failed".into(),
                },
                Err(error) => return Err(error),
            };
            let mut state = self.state()?;
            if state.generation != generation {
                return Err(Error::SessionChanged);
            }
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.guard(self.clock.now())?;
            let current = s.drafts.get_mut(&record.draft.id).ok_or(Error::Conflict)?;
            if current.version != record.version {
                return Err(Error::Conflict);
            }
            current.state = if response.outcome == "accepted-as-draft" {
                current.server_version = Some(record.version);
                "synced"
            } else if response.outcome == "conflict" {
                "conflict"
            } else {
                "error"
            }
            .into();
            current.result = Some(response.clone());
            results.push(response);
        }
        Ok(results)
    }
}
