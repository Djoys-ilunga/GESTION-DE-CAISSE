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
    sync_lock: tokio::sync::Mutex<()>,
    pub(crate) persistence: Option<Arc<crate::persistence::Runtime>>,
}
impl Broker {
    /// Only transmission can read a local buffer. Financial confirmations are always explicit.
    pub async fn report_action(
        &self,
        action: &str,
        payload: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        let (generation, _) = self.snapshot(true, true, expected)?;
        let permission = if action == "close" {
            "session:manage"
        } else {
            "ledger:read"
        };
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission(permission)?;
        if !["snapshot", "pdf", "xlsx", "valuation", "close"].contains(&action) {
            return Err(Error::Forbidden);
        }
        self.revalidate(Some(generation)).await?;
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission(permission)?;
        let payload = payload.unwrap_or_else(|| json!({}));
        let (method, path, body) = if action == "valuation" {
            if payload.get("confirmed") != Some(&Value::Bool(true)) {
                return Err(Error::InvalidInput);
            }
            (Method::POST, "reports/valuation".into(), Some(payload))
        } else if action == "close" {
            if payload.get("confirmed") != Some(&Value::Bool(true)) {
                return Err(Error::InvalidInput);
            }
            (Method::POST, "reports/close".into(), Some(payload))
        } else {
            let path = match action {
                "pdf" => "reports/pdf",
                "xlsx" => "reports/xlsx",
                _ => "reports",
            };
            (
                Method::GET,
                Self::query_path(
                    path,
                    &payload,
                    &[
                        "period",
                        "date",
                        "from",
                        "to",
                        "agencyId",
                        "cashRegisterId",
                        "userId",
                        "category",
                        "kind",
                    ],
                )?,
                None,
            )
        };
        let value = self
            .protected(method, &path, body, Some(generation))
            .await?;
        let mut state = self.state()?;
        Self::generation(&state, Some(generation))?;
        let session = state.session.as_mut().ok_or(Error::AuthRequired)?;
        session.guard(self.clock.now())?;
        if action == "close" {
            session.balances = None;
            session.cash_catalog = None;
        }
        self.persist(&mut state)?;
        Ok(value)
    }
    pub async fn transfer_action(
        &self,
        action: &str,
        payload: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        let (generation, _) = self.snapshot(true, true, expected)?;
        let payload = payload.unwrap_or_else(|| json!({}));
        let permission = match action {
            "send" => "draft:write_own",
            "list" | "detail" => "ledger:read",
            "handover" | "receive" => "transfer:post",
            _ => return Err(Error::Forbidden),
        };
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission(permission)?;
        let id = || {
            Uuid::parse_str(
                payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)
        };
        self.revalidate(Some(generation)).await?;
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission(permission)?;
        let mut sent_buffer = None;
        let (method, path, body) = match action {
            "send" => {
                let buffer = {
                    let mut state = self.state()?;
                    let session = state.session.as_mut().ok_or(Error::AuthRequired)?;
                    session
                        .list_form_buffers(self.clock.now())?
                        .into_iter()
                        .find(|b| b.id == id().unwrap_or_default())
                        .ok_or(Error::InvalidInput)?
                };
                if buffer.kind != "transfer" {
                    return Err(Error::InvalidInput);
                }
                let fields = &buffer.fields;
                let currency = fields.get("currency").ok_or(Error::InvalidInput)?;
                let destination_currency = fields
                    .get("destinationCurrency")
                    .ok_or(Error::InvalidInput)?;
                let rate = if currency == destination_currency {
                    Value::Null
                } else {
                    json!(fields.get("rate").ok_or(Error::InvalidInput)?)
                };
                let mut body = json!({"id":buffer.id,"sourceCashRegisterId":buffer.cash_register_id,
                    "destinationCashRegisterId":fields.get("destinationCashRegisterId"),"sourceCurrency":currency,
                    "destinationCurrency":destination_currency,"amount":fields.get("amount"),"rate":rate,
                    "rateSource":fields.get("rateSource").map(String::as_str).unwrap_or(""),"description":fields.get("description")});
                if let Some(quote) = fields.get("rateQuoteId").filter(|v| !v.is_empty()) {
                    body["rateQuoteId"] =
                        json!(Uuid::parse_str(quote).map_err(|_| Error::InvalidInput)?);
                }
                sent_buffer = Some(buffer);
                (Method::POST, "transfers/drafts".into(), Some(body))
            }
            "list" => (
                Method::GET,
                Self::query_path("transfers", &payload, &["page", "state"])?,
                None,
            ),
            "detail" => (Method::GET, format!("transfers/{}", id()?), None),
            "handover" => {
                if payload.get("handedOver") != Some(&Value::Bool(true)) {
                    return Err(Error::InvalidInput);
                }
                (
                    Method::POST,
                    format!("transfers/{}/handover", id()?),
                    Some(
                        json!({"expectedVersion":payload["expectedVersion"],"handedOver":true,"rateValidated":payload["rateValidated"]}),
                    ),
                )
            }
            "receive" => {
                if payload.get("received") != Some(&Value::Bool(true)) {
                    return Err(Error::InvalidInput);
                }
                (
                    Method::POST,
                    format!("transfers/{}/receive", id()?),
                    Some(json!({"expectedVersion":payload["expectedVersion"],"received":true})),
                )
            }
            _ => return Err(Error::Forbidden),
        };
        let value = self
            .protected(method, &path, body, Some(generation))
            .await?;
        let mut state = self.state()?;
        Self::generation(&state, Some(generation))?;
        let session = state.session.as_mut().ok_or(Error::AuthRequired)?;
        session.guard(self.clock.now())?;
        // A lost acknowledgement retains the UUID. A newer edit is never discarded.
        if let Some(buffer) = sent_buffer {
            if value.get("id").and_then(Value::as_str) != Some(buffer.id.to_string().as_str()) {
                return Err(Error::InvalidResponse);
            }
        }
        if ["handover", "receive"].contains(&action) {
            session.balances = None;
            session.cash_catalog = None;
        }
        self.persist(&mut state)?;
        Ok(value)
    }
    pub async fn expense_action(
        &self,
        action: &str,
        payload: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        let (generation, _) = self.snapshot(true, true, expected)?;
        let payload = payload.unwrap_or_else(|| json!({}));
        let permission = match action {
            "policies" | "configure" => "cash:configure",
            "drafts" | "restore" => "draft:read_own",
            "submit" => "expense:request",
            "decide" => "expense:approve",
            "pay" => "expense:pay",
            "list" | "detail" | "voucher" | "evidence" => "ledger:read",
            _ => return Err(Error::Forbidden),
        };
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission(permission)?;
        let uuid_field = |key: &str| -> Result<Uuid> {
            Uuid::parse_str(
                payload
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)
        };
        let id = || uuid_field("id");
        if ["submit", "decide", "pay", "configure"].contains(&action) {
            if (action == "submit" && payload.get("submitted") != Some(&Value::Bool(true)))
                || (action == "pay" && payload.get("paid") != Some(&Value::Bool(true)))
            {
                return Err(Error::InvalidInput);
            }
            self.revalidate(Some(generation)).await?;
            self.state()?
                .session
                .as_ref()
                .ok_or(Error::AuthRequired)?
                .permission(permission)?;
        }
        let (method, path, body) = match action {
            "policies" => (Method::GET, "expenses/policies".into(), None),
            "configure" => {
                let currency = payload
                    .get("currency")
                    .and_then(Value::as_str)
                    .filter(|s| s.len() == 3 && s.bytes().all(|c| c.is_ascii_uppercase()))
                    .ok_or(Error::InvalidInput)?;
                (
                    Method::PUT,
                    format!("expenses/policies/{currency}"),
                    Some(payload.get("data").ok_or(Error::InvalidInput)?.clone()),
                )
            }
            "drafts" => (
                Method::GET,
                Self::query_path("expenses/drafts", &payload, &["page"])?,
                None,
            ),
            "restore" => (Method::GET, format!("expenses/drafts/{}", id()?), None),
            "list" => (
                Method::GET,
                Self::query_path(
                    "expenses/requests",
                    &payload,
                    &["page", "state", "currency", "cashRegisterId"],
                )?,
                None,
            ),
            "detail" => (Method::GET, format!("expenses/requests/{}", id()?), None),
            "submit" => (
                Method::POST,
                format!("expenses/drafts/{}/submit", id()?),
                Some(json!({"expectedVersion":payload["expectedVersion"],"submitted":true})),
            ),
            "decide" => (
                Method::POST,
                format!("expenses/requests/{}/decision", id()?),
                Some(payload.get("data").ok_or(Error::InvalidInput)?.clone()),
            ),
            "pay" => (
                Method::POST,
                format!("expenses/requests/{}/pay", id()?),
                Some(json!({"expectedVersion":payload["expectedVersion"],"paid":true})),
            ),
            "voucher" => (Method::GET, format!("expenses/vouchers/{}", id()?), None),
            "evidence" => (
                Method::GET,
                format!(
                    "expenses/requests/{}/evidence/{}",
                    id()?,
                    uuid_field("evidenceId")?
                ),
                None,
            ),
            _ => return Err(Error::Forbidden),
        };
        let value = self
            .protected(method, &path, body, Some(generation))
            .await?;
        let now = self.clock.now();
        let mut state = self.state()?;
        Self::generation(&state, Some(generation))?;
        let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
        s.guard(now)?;
        if action == "submit" || action == "drafts" {
            let rows = if action == "submit" {
                vec![&value]
            } else {
                value
                    .get("items")
                    .and_then(Value::as_array)
                    .ok_or(Error::InvalidResponse)?
                    .iter()
                    .collect()
            };
            for row in rows {
                let submitted = if action == "submit" {
                    row.get("id")
                } else {
                    row.get("expenseRequestId")
                };
                if let Some(submitted) = submitted.filter(|v| !v.is_null()) {
                    let request_id =
                        Uuid::parse_str(submitted.as_str().ok_or(Error::InvalidResponse)?)
                            .map_err(|_| Error::InvalidResponse)?;
                    let client_id = Uuid::parse_str(
                        row.get("clientDraftId")
                            .and_then(Value::as_str)
                            .ok_or(Error::InvalidResponse)?,
                    )
                    .map_err(|_| Error::InvalidResponse)?;
                    if let Some(record) = s.drafts.get_mut(&client_id) {
                        if record.draft.kind != "expense-request" {
                            return Err(Error::InvalidResponse);
                        }
                        record.state = "submitted".into();
                        record.submitted_expense_id = Some(request_id);
                        record.result = None;
                    }
                }
            }
        }
        if action == "pay" || action == "decide" {
            s.balances = None;
            s.cash_catalog = None;
        }
        if action == "restore" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Remote {
                server_id: Uuid,
                original_created_at: Option<String>,
                updated_at: Option<String>,
                client_draft_id: Uuid,
                agency_id: Uuid,
                cash_register_id: Option<Uuid>,
                version: u32,
                currency: String,
                amount: String,
                description: String,
                expense_details: Option<ExpenseDetails>,
            }
            let remote: Remote =
                serde_json::from_value(value).map_err(|_| Error::InvalidResponse)?;
            if let Some(old) = s.drafts.get(&remote.client_draft_id) {
                if millis(&old.draft.expires_at)? > now {
                    if old.state == "synced" && old.version == remote.version {
                        return serde_json::to_value(old).map_err(|_| Error::InvalidResponse);
                    }
                    return Err(Error::Conflict);
                }
            }
            if remote.version == 0 {
                return Err(Error::InvalidResponse);
            }
            let mut record = s.save_draft(
                SaveDraft {
                    draft: Draft {
                        id: remote.client_draft_id,
                        kind: "expense-request".into(),
                        currency: remote.currency,
                        amount: remote.amount,
                        description: remote.description,
                        created_at: crate::state::iso(now),
                        expires_at: crate::state::iso((now + 900000).min(s.absolute_until)),
                        receipt_details: None,
                        expense_details: remote.expense_details,
                    },
                    agency_id: remote.agency_id,
                    cash_register_id: remote.cash_register_id,
                    expected_version: None,
                },
                now,
            )?;
            record.version = remote.version;
            record.server_version = Some(remote.version);
            record.server_id = Some(remote.server_id);
            record.original_created_at = remote.original_created_at.or(record.original_created_at);
            if let Some(updated) = remote.updated_at {
                record.updated_at = updated;
            }
            record.state = "synced".into();
            s.drafts.insert(record.draft.id, record.clone());
            self.persist(&mut state)?;
            return serde_json::to_value(record).map_err(|_| Error::InvalidResponse);
        }
        self.persist(&mut state)?;
        Ok(value)
    }
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
            self.persist(&mut state)?;
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
                if value.len() > 600 {
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
                record.state = "conflict".into();
            } else {
                record.state = "confirmed".into();
            }
            record.confirmed_receipt_id = Some(id);
            record.receipt_number = Some(number.into());
            record.result = None;
            s.pending_sync.remove(&client);
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
                server_id: Uuid,
                original_created_at: Option<String>,
                updated_at: Option<String>,
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
                    expense_details: None,
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
            record.server_id = Some(remote.server_id);
            record.original_created_at = remote.original_created_at.or(record.original_created_at);
            if let Some(updated) = remote.updated_at {
                record.updated_at = updated;
            }
            record.state = "synced".into();
            s.drafts.insert(record.draft.id, record.clone());
            self.persist(&mut state)?;
            return serde_json::to_value(record).map_err(|_| Error::InvalidResponse);
        }
        self.persist(&mut state)?;
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
            sync_lock: tokio::sync::Mutex::new(()),
            persistence: None,
        })
    }
    /// Production activation still requires the native platform qualification gate.
    pub fn with_native_storage(
        base: &str,
        deployment: &str,
        root: std::path::PathBuf,
        allow_debug_loopback: bool,
    ) -> Result<Self> {
        let mut broker = Self::new(base, deployment, Uuid::new_v4(), allow_debug_loopback)?;
        if !caissepro_local_store::PLATFORM_STORAGE_VALIDATED {
            return Ok(broker);
        }
        let runtime = crate::persistence::Runtime::new(
            root,
            base,
            deployment,
            Arc::new(caissepro_local_store::NativeKeyVault),
        )?;
        broker.device = runtime.device;
        match runtime.restore(broker.clock.now()) {
            Ok(session) => {
                broker.state()?.session = session;
            }
            Err(_) => {
                broker.state()?.reason = Some("LOCAL_STORAGE_UNAVAILABLE".into());
            }
        }
        broker.persistence = Some(runtime);
        Ok(broker)
    }
    fn persist(&self, state: &mut State) -> Result<()> {
        let result = if let Some(session) = state.session.as_mut() {
            if session.durable.is_none() {
                if let Some(runtime) = &self.persistence {
                    runtime.attach(session, self.clock.now())
                } else {
                    Ok(())
                }
            } else {
                session.checkpoint(self.clock.now())
            }
        } else {
            Ok(())
        };
        if result.is_err() {
            state.clear("LOCAL_STORAGE_UNAVAILABLE");
            return Err(Error::LocalStorage);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn with_test_storage(
        base: &str,
        runtime: Arc<crate::persistence::Runtime>,
        restore: bool,
    ) -> Result<Self> {
        let mut broker = Self::new(base, "test", runtime.device, true)?;
        if restore {
            broker.state()?.session = runtime.restore(broker.clock.now())?;
        }
        broker.persistence = Some(runtime);
        Ok(broker)
    }
    #[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
    pub(crate) fn test_device(&self) -> Uuid {
        self.device
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
        if path.starts_with("exchange-rates") && response.status().as_u16() == 409 {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
                if bytes.len() + chunk.len() > 4096 {
                    return Err(Error::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
            return Err(match body.get("code").and_then(Value::as_str) {
                Some("BCC_AUTHORIZATION_REQUIRED") => Error::BccAuthorizationRequired,
                Some("BCC_SOURCE_UNVERIFIED") => Error::BccUnverified,
                Some("BCC_RATE_UNAVAILABLE") => Error::BccUnavailable,
                Some("RATE_QUOTE_STALE" | "RATE_POLICY_CHANGED" | "RATE_QUOTE_INVALID") => {
                    Error::RateStale
                }
                Some("MANUAL_RATE_FORBIDDEN") => Error::ManualRateForbidden,
                _ => Error::SettingsConflict,
            });
        }
        if path.starts_with("expenses/") && [403, 409].contains(&response.status().as_u16()) {
            let forbidden = response.status().as_u16() == 403;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
                if bytes.len().saturating_add(chunk.len()) > 4096 {
                    return Err(Error::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
            return Err(match body.get("code").and_then(Value::as_str) {
                Some("EXPENSE_POLICY_REQUIRED") => Error::ExpensePolicy,
                Some("EXPENSE_LIMIT_EXCEEDED") => Error::ExpenseLimit,
                Some("INSUFFICIENT_FUNDS") => Error::InsufficientFunds,
                Some("EXPENSE_EVIDENCE_REQUIRED") => Error::ExpenseEvidence,
                _ if forbidden => Error::Forbidden,
                _ => Error::ExpenseConflict,
            });
        }
        if path.starts_with("reports") && response.status().as_u16() == 409 {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
                if bytes.len() + chunk.len() > 4096 {
                    return Err(Error::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
            return Err(match body.get("code").and_then(Value::as_str) {
                Some("REPORT_TOO_LARGE") => Error::ReportTooLarge,
                Some("REPORT_DATES_INVALID") => Error::ReportDates,
                Some("CLOSURE_RESERVED_FUNDS") => Error::ClosureReserved,
                _ => Error::ClosureConflict,
            });
        }
        if (path.starts_with("management") || path.starts_with("money"))
            && response.status().as_u16() == 409
        {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
                if bytes.len() + chunk.len() > 4096 {
                    return Err(Error::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
            return Err(match body.get("code").and_then(Value::as_str) {
                Some("REPORT_TOO_LARGE") => Error::ReportTooLarge,
                Some("AGENCY_HAS_ACTIVE_CASH") => Error::AgencyHasActiveCash,
                Some("CURRENCY_INACTIVE") | Some("CURRENCY_UNKNOWN") => Error::CurrencyInactive,
                Some("CURRENCY_IN_USE") => Error::CurrencyInUse,
                Some("CURRENCY_PRECISION") => Error::CurrencyPrecision,
                _ => Error::SettingsConflict,
            });
        }
        if path.starts_with("transfers") && response.status().as_u16() == 409 {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
                if bytes.len().saturating_add(chunk.len()) > 4096 {
                    return Err(Error::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
            return Err(match body.get("code").and_then(Value::as_str) {
                Some("INSUFFICIENT_FUNDS") => Error::InsufficientFunds,
                Some("TRANSFER_DISTINCT_RECEIVER_REQUIRED") => Error::TransferReceiver,
                Some("RATE_QUOTE_STALE" | "RATE_POLICY_CHANGED" | "RATE_QUOTE_INVALID") => {
                    Error::RateStale
                }
                Some("MANUAL_RATE_FORBIDDEN") => Error::ManualRateForbidden,
                _ => Error::TransferConflict,
            });
        }
        if path == "workspace/drafts/sync" && response.status().as_u16() == 409 {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
                if bytes.len().saturating_add(chunk.len()) > 4096 {
                    return Err(Error::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
            return Err(match body.get("code").and_then(Value::as_str) {
                Some(
                    "DRAFT_DATES_INVALID"
                    | "DRAFT_EXPIRED"
                    | "DRAFT_CASH_REQUIRED"
                    | "EVIDENCE_INVALID",
                ) => Error::InvalidInput,
                _ => Error::Conflict,
            });
        }
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
        let response_limit = if path.starts_with("reports") {
            12_000_000
        } else {
            2_000_000
        };
        if response
            .content_length()
            .is_some_and(|size| size > response_limit as u64)
        {
            return Err(Error::InvalidResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
            if bytes.len().saturating_add(chunk.len()) > response_limit {
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
            || health.get("protocolVersion").and_then(Value::as_u64) != Some(2)
            || health.get("deploymentId").and_then(Value::as_str) != Some(&self.deployment)
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub async fn check_health(&self) -> Result<Value> {
        self.health().await?;
        Ok(
            json!({"service":"caissepro-api","protocolVersion":2,"deploymentId":self.deployment,"status":"ready"}),
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
        let mut session = Session::new(token, response.profile, verifier, self.clock.now())?;
        if let Some(runtime) = &self.persistence {
            runtime.attach(&mut session, self.clock.now())?;
        }
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
        let view = self.status()?;
        if view.reason.as_deref() == Some("LOCAL_STORAGE_UNAVAILABLE") {
            return Err(Error::LocalStorage);
        }
        Ok(view)
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
            self.persist(&mut state)?;
        }
        if token.is_empty() {
            return self.status();
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
        if token.is_empty() {
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            if let Some(s) = state.session.as_mut() {
                s.locked = true;
            }
            state.reason = Some("REAUTHENTICATION_REQUIRED".into());
            return Err(Error::OnlineRequired);
        }
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
                let scope_changed = !profile.same_scope(&session.profile);
                if scope_changed {
                    if session.detach_storage("SCOPE_CHANGED").is_err() {
                        state.clear("LOCAL_STORAGE_UNAVAILABLE");
                        return Err(Error::LocalStorage);
                    }
                    session.balances = None;
                    session.cash_catalog = None;
                    session.money_context = None;
                    session.drafts.clear();
                    session.pending_sync.clear();
                    session.form_buffers.clear();
                    session.sync_events.clear();
                    session.last_sync_success = None;
                    session.sync_cache_updated = None;
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
                if scope_changed {
                    state.generation += 1;
                }
                state.reason = None;
                self.persist(&mut state)?;
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
                if token.is_empty() {
                    let (company, email) = {
                        let state = self.state()?;
                        Self::generation(&state, Some(generation))?;
                        let s = state.session.as_ref().ok_or(Error::AuthRequired)?;
                        (s.profile.company.code.clone(), s.profile.user.email.clone())
                    };
                    return self.login(company, email, password).await;
                }
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
                            if s.detach_storage("SCOPE_CHANGED").is_err() {
                                state.clear("LOCAL_STORAGE_UNAVAILABLE");
                                return Err(Error::LocalStorage);
                            }
                            s.balances = None;
                            s.cash_catalog = None;
                            s.money_context = None;
                            s.drafts.clear();
                            s.pending_sync.clear();
                            s.form_buffers.clear();
                            s.sync_events.clear();
                            s.last_sync_success = None;
                            s.sync_cache_updated = None;
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
                        self.persist(&mut state)?;
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
                    if let Some(session) = state.session.as_mut() {
                        session.checkpoint(now)?;
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
                self.persist(&mut state)?;
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
        if ["money-context", "money-preferences"].contains(&action) {
            let (generation, _) = self.snapshot(true, false, expected)?;
            {
                let state = self.state()?;
                let session = state.session.as_ref().ok_or(Error::AuthRequired)?;
                if !session.online {
                    session.permission("offline:access")?;
                    if action != "money-context" {
                        return Err(Error::OnlineRequired);
                    }
                    return session.money_context.clone().ok_or(Error::OnlineRequired);
                }
            }
            self.revalidate(Some(generation)).await?;
            let value = self
                .protected(
                    if action == "money-context" {
                        Method::GET
                    } else {
                        Method::PUT
                    },
                    if action == "money-context" {
                        "money/context"
                    } else {
                        "money/preferences"
                    },
                    if action == "money-context" {
                        None
                    } else {
                        payload
                    },
                    Some(generation),
                )
                .await?;
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            let session = state.session.as_mut().ok_or(Error::AuthRequired)?;
            session.guard(self.clock.now())?;
            session.money_context = Some(value.clone());
            self.persist(&mut state)?;
            return Ok(value);
        }
        let (generation, _) = self.snapshot(true, true, expected)?;
        let permission = match action {
            "money-currencies" | "money-reporting" | "settings" | "company" | "agency"
            | "category" | "rate" => "cash:configure",
            "references" => "directory:read",
            "supervision" | "exchange-rates" | "exchange-history" | "exchange-quote" => {
                "ledger:read"
            }
            "exchange-refresh" | "exchange-policy" => "cash:configure",
            "audit" | "audit-pdf" | "audit-xlsx" | "logs" => "auth:logs:read",
            "access" => "roles:assign",
            "users" | "catalog" | "create" => "users:manage",
            _ => return Err(Error::Forbidden),
        };
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission(permission)?;
        if [
            "exchange-refresh",
            "exchange-policy",
            "money-currencies",
            "money-reporting",
            "company",
            "agency",
            "category",
            "rate",
        ]
        .contains(&action)
        {
            if payload.as_ref().and_then(|v| v.get("confirmed")) != Some(&Value::Bool(true)) {
                return Err(Error::InvalidInput);
            }
            self.revalidate(Some(generation)).await?;
            self.state()?
                .session
                .as_ref()
                .ok_or(Error::AuthRequired)?
                .permission(permission)?;
        }
        let (method, path, body) = match action {
            "exchange-rates" => (Method::GET, "exchange-rates".into(), None),
            "exchange-history" => (
                Method::GET,
                Self::query_path(
                    "exchange-rates/history",
                    &payload.unwrap_or_else(|| json!({})),
                    &["page"],
                )?,
                None,
            ),
            "exchange-refresh" => (Method::POST, "exchange-rates/refresh".into(), payload),
            "exchange-policy" => (Method::PUT, "exchange-rates/policy".into(), payload),
            "exchange-quote" => (Method::POST, "exchange-rates/quote".into(), payload),
            "money-currencies" => (Method::PUT, "money/currencies".into(), payload),
            "money-reporting" => (Method::PUT, "money/reporting".into(), payload),
            "settings" => (Method::GET, "management/settings".into(), None),
            "references" => (Method::GET, "management/references".into(), None),
            "supervision" => (Method::GET, "management/supervision".into(), None),
            "audit" | "audit-pdf" | "audit-xlsx" => (
                Method::GET,
                Self::query_path(
                    if action == "audit-pdf" {
                        "management/audit/pdf"
                    } else if action == "audit-xlsx" {
                        "management/audit/xlsx"
                    } else {
                        "management/audit"
                    },
                    &payload.unwrap_or_else(|| json!({})),
                    &["page", "from", "to", "action", "actorId", "cashRegisterId"],
                )?,
                None,
            ),
            "company" => (Method::PUT, "management/company".into(), payload),
            "category" => (Method::POST, "management/categories".into(), payload),
            "rate" => (Method::POST, "management/rates".into(), payload),
            "agency" => {
                let mut value = payload.ok_or(Error::InvalidInput)?;
                let id = Uuid::parse_str(
                    value
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or(Error::InvalidInput)?,
                )
                .map_err(|_| Error::InvalidInput)?;
                value
                    .as_object_mut()
                    .ok_or(Error::InvalidInput)?
                    .remove("id");
                (
                    Method::PUT,
                    format!("management/agencies/{id}"),
                    Some(value),
                )
            }
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
        let value = self.protected(method, &path, body, expected).await?;
        if action == "company" && value.get("sessionsRevoked") == Some(&Value::Bool(true)) {
            let mut state = self.state()?;
            if state.generation == generation {
                state.clear("SESSION_REVOKED");
            }
        }
        Ok(value)
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
        let record = state
            .session
            .as_mut()
            .ok_or(Error::AuthRequired)?
            .save_draft(input, now)?;
        self.persist(&mut state)?;
        Ok(record)
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
            self.persist(&mut state)?;
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
    pub fn synchronization_status(&self, expected: Option<u64>) -> Result<Value> {
        let (generation, _) = self.snapshot(true, false, expected)?;
        let mut state = self.state()?;
        Self::generation(&state, Some(generation))?;
        let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
        let records = s.list_drafts(self.clock.now())?;
        let mut counts =
            json!({"local":0,"queued":0,"syncing":0,"synced":0,"conflict":0,"error":0});
        for r in records {
            let key = if ["confirmed", "submitted"].contains(&r.state.as_str()) {
                "synced"
            } else {
                r.state.as_str()
            };
            if let Some(value) = counts.get_mut(key) {
                *value = json!(value.as_u64().unwrap_or(0) + 1);
            }
        }
        Ok(
            json!({"running":self.sync_lock.try_lock().is_err(),"apiOnline":s.online,"lastSuccessfulAt":s.last_sync_success,"cacheUpdatedAt":s.sync_cache_updated,"counts":counts,"persistence":if s.durable.is_some(){"encrypted-sqlcipher"}else{"memory-only"},"retentionMs":crate::state::DRAFT_RETENTION_MS,"lastSavedAt":s.durable.as_ref().map(|d|crate::state::iso(d.saved_at)),"events":s.sync_events}),
        )
    }
    pub async fn synchronization_action(
        &self,
        action: &str,
        payload: Option<Value>,
        expected: Option<u64>,
    ) -> Result<Value> {
        if action == "status" {
            return self.synchronization_status(expected);
        }
        let (generation, _) = self.snapshot(true, false, expected)?;
        let payload = payload.unwrap_or_else(|| json!({}));
        let id = || -> Result<Uuid> {
            Uuid::parse_str(
                payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)
        };
        if action == "retry" {
            let _worker = self.sync_lock.try_lock().map_err(|_| Error::SyncBusy)?;
            let id = id()?;
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.permission("draft:write_own")?;
            let r = s.drafts.get_mut(&id).ok_or(Error::InvalidInput)?;
            if r.state == "conflict"
                || r.confirmed_receipt_id.is_some()
                || r.submitted_expense_id.is_some()
                || r.state == "synced"
            {
                return Err(Error::Conflict);
            }
            if payload.get("expectedVersion").and_then(Value::as_u64) != Some(u64::from(r.version))
            {
                return Err(Error::Conflict);
            }
            r.attempts = 0;
            r.next_attempt_at = None;
            r.state = "queued".into();
            r.result = None;
            let value = serde_json::to_value(r).map_err(|_| Error::InvalidResponse)?;
            self.persist(&mut state)?;
            return Ok(value);
        }
        if ["buffers", "buffer-save", "buffer-remove"].contains(&action) {
            let now = self.clock.now();
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            if action == "buffers" {
                return serde_json::to_value(s.list_form_buffers(now)?)
                    .map_err(|_| Error::InvalidResponse);
            }
            if action == "buffer-save" {
                let input: FormBufferInput =
                    serde_json::from_value(payload).map_err(|_| Error::InvalidInput)?;
                let value = serde_json::to_value(s.save_form_buffer(input, now)?)
                    .map_err(|_| Error::InvalidResponse)?;
                self.persist(&mut state)?;
                return Ok(value);
            }
            s.permission("draft:write_own")?;
            s.form_buffers.remove(&id()?);
            self.persist(&mut state)?;
            return Ok(json!({"removed":true}));
        }
        self.snapshot(true, true, Some(generation))?;
        self.state()?
            .session
            .as_ref()
            .ok_or(Error::AuthRequired)?
            .permission("draft:read_own")?;
        if ["resolve", "restore"].contains(&action) {
            let _worker = self.sync_lock.try_lock().map_err(|_| Error::SyncBusy)?;
            self.revalidate(Some(generation)).await?;
            let client = id()?;
            let raw = self
                .protected(
                    Method::GET,
                    &format!("workspace/sync/drafts/{client}"),
                    None,
                    Some(generation),
                )
                .await?;
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Remote {
                server_id: Uuid,
                client_draft_id: Uuid,
                agency_id: Uuid,
                cash_register_id: Option<Uuid>,
                kind: String,
                version: u32,
                created_at: String,
                updated_at: String,
                received_at: String,
                source_state: String,
                receipt_id: Option<Uuid>,
                expense_request_id: Option<Uuid>,
                currency: String,
                amount: String,
                description: String,
                receipt_details: Option<ReceiptDetails>,
                expense_details: Option<ExpenseDetails>,
            }
            let remote: Remote = serde_json::from_value(raw).map_err(|_| Error::InvalidResponse)?;
            if remote.client_draft_id != client
                || remote.version == 0
                || remote.version > i32::MAX as u32
                || millis(&remote.updated_at)? < millis(&remote.created_at)?
                || millis(&remote.received_at)? > self.clock.now() + 30000
                || !["draft", "confirmed", "submitted"].contains(&remote.source_state.as_str())
                || (remote.source_state == "confirmed"
                    && (remote.receipt_id.is_none() || remote.kind != "receipt"))
                || (remote.source_state == "submitted"
                    && (remote.expense_request_id.is_none() || remote.kind != "expense-request"))
            {
                return Err(Error::InvalidResponse);
            }
            let choice = if action == "restore" {
                "server"
            } else {
                payload
                    .get("choice")
                    .and_then(Value::as_str)
                    .filter(|s| ["local", "server"].contains(s))
                    .ok_or(Error::InvalidInput)?
            };
            let now = self.clock.now();
            let mut state = self.state()?;
            Self::generation(&state, Some(generation))?;
            let s = state.session.as_mut().ok_or(Error::AuthRequired)?;
            s.guard(now)?;
            s.permission("draft:write_own")?;
            s.scope(remote.agency_id, remote.cash_register_id)?;
            if let Some(local) = s.drafts.get(&client) {
                if action == "restore"
                    || payload.get("expectedVersion").and_then(Value::as_u64)
                        != Some(u64::from(local.version))
                    || local.agency_id != remote.agency_id
                    || local.cash_register_id != remote.cash_register_id
                    || local.draft.kind != remote.kind
                {
                    return Err(Error::Conflict);
                }
            } else if action == "resolve" {
                return Err(Error::Conflict);
            }
            if choice == "local" {
                let r = s.drafts.get_mut(&client).ok_or(Error::Conflict)?;
                if remote.source_state != "draft" {
                    r.state = "conflict".into();
                    r.confirmed_receipt_id = remote.receipt_id;
                    r.submitted_expense_id = remote.expense_request_id;
                    return Err(Error::Conflict);
                }
                r.version = r
                    .version
                    .max(remote.version)
                    .checked_add(1)
                    .filter(|v| *v <= i32::MAX as u32)
                    .ok_or(Error::Conflict)?;
                r.server_id = Some(remote.server_id);
                r.server_version = Some(remote.version);
                r.updated_at = crate::state::iso(now.max(millis(&remote.updated_at)?));
                r.original_created_at = Some(remote.created_at);
                r.attempts = 0;
                r.next_attempt_at = None;
                r.state = "queued".into();
                r.result = None;
                s.pending_sync.remove(&client);
                return serde_json::to_value(r).map_err(|_| Error::InvalidResponse);
            }
            let old = s.drafts.remove(&client);
            let input = SaveDraft {
                draft: Draft {
                    id: client,
                    kind: remote.kind,
                    currency: remote.currency,
                    amount: remote.amount,
                    description: remote.description,
                    created_at: crate::state::iso(now),
                    expires_at: crate::state::iso((now + 900000).min(s.absolute_until)),
                    receipt_details: remote.receipt_details,
                    expense_details: remote.expense_details,
                },
                agency_id: remote.agency_id,
                cash_register_id: remote.cash_register_id,
                expected_version: None,
            };
            let mut record = match s.save_draft(input, now) {
                Ok(r) => r,
                Err(error) => {
                    if let Some(old) = old {
                        s.drafts.insert(client, old);
                    }
                    return Err(error);
                }
            };
            record.version = remote.version;
            record.server_version = Some(remote.version);
            record.server_id = Some(remote.server_id);
            record.original_created_at = Some(remote.created_at);
            record.updated_at = remote.updated_at;
            record.synchronized_at = Some(crate::state::iso(now));
            record.state = match remote.source_state.as_str() {
                "confirmed" => "confirmed",
                "submitted" => "submitted",
                _ => "synced",
            }
            .into();
            record.confirmed_receipt_id = remote.receipt_id;
            record.submitted_expense_id = remote.expense_request_id;
            s.pending_sync.remove(&client);
            s.drafts.insert(client, record.clone());
            self.persist(&mut state)?;
            return serde_json::to_value(record).map_err(|_| Error::InvalidResponse);
        }
        let path = match action {
            "manifest" => Self::query_path("workspace/sync/manifest", &payload, &["page"])?,
            "events" => "workspace/sync/events".into(),
            _ => return Err(Error::Forbidden),
        };
        self.protected(Method::GET, &path, None, Some(generation))
            .await
    }
    pub async fn synchronize(&self, expected: Option<u64>) -> Result<Vec<SyncResult>> {
        let _worker = self.sync_lock.try_lock().map_err(|_| Error::SyncBusy)?;
        let (generation, _) = self.snapshot(true, false, expected)?;
        self.revalidate(Some(generation)).await?;
        let records = self.drafts(Some(generation))?;
        let mut results = Vec::new();
        for record in records {
            let pending = {
                let mut state = self.state()?;
                Self::generation(&state, Some(generation))?;
                let pending = state
                    .session
                    .as_mut()
                    .ok_or(Error::AuthRequired)?
                    .prepare_sync(record.draft.id, self.clock.now())?;
                self.persist(&mut state)?;
                pending
            };
            let Some(pending) = pending else {
                continue;
            };
            let r = &pending.record;
            let result=self.protected(Method::POST,"workspace/drafts/sync",Some(json!({"syncProtocol":2,"draft":r.draft,"agencyId":r.agency_id,"cashRegisterId":r.cash_register_id,"version":r.version,"expectedServerVersion":r.server_version,"originalCreatedAt":r.original_created_at.as_ref().unwrap_or(&r.draft.created_at),"updatedAt":r.updated_at})),Some(generation)).await;
            let mut transport_error = None;
            let response = match result {
                Ok(value) => match serde_json::from_value::<SyncResult>(value) {
                    Ok(response) => response,
                    Err(_) => {
                        self.fail(generation, &Error::InvalidResponse)?;
                        return Err(Error::InvalidResponse);
                    }
                },
                Err(Error::Conflict) => SyncResult::failure(r.draft.id, "conflict", "conflict"),
                Err(Error::Forbidden | Error::InvalidInput) => {
                    SyncResult::failure(r.draft.id, "rejected", "validation-failed")
                }
                Err(error @ (Error::Unavailable | Error::Throttled)) => {
                    let code = if matches!(error, Error::Throttled) {
                        "rate-limited"
                    } else {
                        "transport-error"
                    };
                    transport_error = Some(error);
                    SyncResult::failure(r.draft.id, "deferred", code)
                }
                Err(error) => return Err(error),
            };
            let applied = {
                let mut state = self.state()?;
                Self::generation(&state, Some(generation))?;
                let applied = state
                    .session
                    .as_mut()
                    .ok_or(Error::AuthRequired)?
                    .finish_sync(&pending, response.clone(), self.clock.now());
                if applied.is_ok() {
                    self.persist(&mut state)?;
                }
                applied
            };
            if let Err(error) = applied {
                self.fail(generation, &error)?;
                return Err(error);
            }
            results.push(response);
            if let Some(error) = transport_error {
                return Err(error);
            }
        }
        if results.iter().any(|r| r.outcome == "accepted-as-draft") {
            let allowed = self
                .state()?
                .session
                .as_ref()
                .is_some_and(|s| s.profile.permissions.iter().any(|p| p == "ledger:read"));
            if allowed {
                let refreshed = self.balances(Some(generation)).await.is_ok()
                    && self.cash_catalog(Some(generation)).await.is_ok();
                let mut state = self.state()?;
                Self::generation(&state, Some(generation))?;
                if !refreshed {
                    if let Some(last) = results.last() {
                        state
                            .session
                            .as_mut()
                            .ok_or(Error::AuthRequired)?
                            .sync_note(
                                last.draft_id,
                                last.server_version.unwrap_or(1),
                                "cache-refresh-failed",
                                self.clock.now(),
                            );
                    }
                }
                if refreshed {
                    state
                        .session
                        .as_mut()
                        .ok_or(Error::AuthRequired)?
                        .sync_cache_updated = Some(crate::state::iso(self.clock.now()));
                }
            }
        }
        Ok(results)
    }
}
