use crate::state::{iso, wall_now};
use crate::{Broker, Draft, Error, Profile, SaveDraft};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;
use zeroize::Zeroizing;
struct Api {
    base: String,
    profile: Arc<Mutex<Profile>>,
    revoked: Arc<AtomicBool>,
    offline: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    writes: Arc<AtomicUsize>,
    logins: Arc<AtomicUsize>,
    deployment: Arc<Mutex<String>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Api {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let now = wall_now();
        let profile=Arc::new(Mutex::new(serde_json::from_value::<Profile>(json!({"sessionId":Uuid::new_v4(),"deviceId":Uuid::new_v4(),"user":{"id":Uuid::new_v4(),"displayName":"Alice test","email":"alice@example.test","mustChangePassword":false},"company":{"id":Uuid::new_v4(),"code":"TEST","name":"Entreprise test"},"roles":["CASHIER"],"permissions":["draft:write_own","draft:read_own"],"agencies":[{"id":Uuid::new_v4(),"code":"A","name":"Agence"}],"cashRegisters":[],"expiresAt":iso(now+3600000),"idleExpiresAt":iso(now+900000),"offlineUntil":null,"validatedAt":iso(now),"locked":false,"authorizationVersion":1})).unwrap()));
        let revoked = Arc::new(AtomicBool::new(false));
        let offline = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let writes = Arc::new(AtomicUsize::new(0));
        let logins = Arc::new(AtomicUsize::new(0));
        let deployment = Arc::new(Mutex::new("test".to_string()));
        let offline_flag = offline.clone();
        let (p, r, s, w, l, d) = (
            profile.clone(),
            revoked.clone(),
            stopped.clone(),
            writes.clone(),
            logins.clone(),
            deployment.clone(),
        );
        let worker = thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => Self::reply(stream, &p, &r, &w, &l, &d, &offline_flag),
                    Err(_) => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self {
            base,
            profile,
            revoked,
            offline,
            stopped,
            writes,
            logins,
            deployment,
            worker: Some(worker),
        }
    }
    fn reply(
        mut stream: TcpStream,
        p: &Mutex<Profile>,
        revoked: &AtomicBool,
        writes: &AtomicUsize,
        logins: &AtomicUsize,
        deployment: &Mutex<String>,
        offline: &AtomicBool,
    ) {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end = loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            }
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                break end + 4;
            }
            if bytes.len() > 65536 {
                return;
            }
        };
        let header = String::from_utf8_lossy(&bytes[..header_end]).to_string();
        let length = header
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while bytes.len() < header_end + length {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            }
        }
        let path = header.split_whitespace().nth(1).unwrap_or("");
        let (status, value) = match path {
            "/api/v1/health/ready" if offline.load(Ordering::SeqCst) => {
                (503, json!({"message":"indisponible"}))
            }
            "/api/v1/health/ready" => (
                200,
                json!({"service":"caissepro-api","status":"ready","protocolVersion":1,"deploymentId":deployment.lock().unwrap().as_str()}),
            ),
            "/api/v1/auth/login" => {
                logins.fetch_add(1, Ordering::SeqCst);
                (
                    201,
                    json!({"accessToken":"a".repeat(43),"profile":*p.lock().unwrap()}),
                )
            }
            "/api/v1/auth/session" if revoked.load(Ordering::SeqCst) => {
                (401, json!({"message":"Révoqué"}))
            }
            "/api/v1/auth/session" => (200, serde_json::to_value(&*p.lock().unwrap()).unwrap()),
            "/api/v1/cash/registers" => {
                let profile = p.lock().unwrap();
                (
                    200,
                    json!({"items":[],"synchronizedAt":profile.validated_at,"expiresAt":profile.offline_until}),
                )
            }
            path if path.starts_with("/api/v1/cash/drafts/") && path.ends_with("/confirm") => {
                writes.fetch_add(1, Ordering::SeqCst);
                (201, json!({"ok":true}))
            }
            "/api/v1/auth/unlock" => (
                201,
                json!({"accessToken":"b".repeat(43),"profile":*p.lock().unwrap()}),
            ),
            "/api/v1/workspace/drafts/sync" => {
                writes.fetch_add(1, Ordering::SeqCst);
                let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                (
                    201,
                    json!({"draftId":body["draft"]["id"],"outcome":"accepted-as-draft","code":"draft-received"}),
                )
            }
            _ => (201, json!({"ok":true})),
        };
        let body = serde_json::to_string(&value).unwrap();
        let _=write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
    }
    fn broker(&self) -> Broker {
        Broker::new(
            &self.base,
            "test",
            self.profile.lock().unwrap().device_id,
            true,
        )
        .unwrap()
    }
    fn draft(&self) -> SaveDraft {
        let now = wall_now();
        SaveDraft {
            draft: Draft {
                receipt_details: None,
                id: Uuid::new_v4(),
                kind: "expense-request".into(),
                currency: "USD".into(),
                amount: "12.34".into(),
                description: "Brouillon privé Alice".into(),
                created_at: iso(now),
                expires_at: iso(now + 600000),
            },
            agency_id: self.profile.lock().unwrap().agencies[0].id,
            cash_register_id: None,
            expected_version: None,
        }
    }
}
impl Drop for Api {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
#[tokio::test]
async fn revoked_session_is_purged_before_any_synchronization() {
    let api = Api::new();
    let broker = api.broker();
    let view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    broker
        .save_draft(api.draft(), Some(view.generation))
        .unwrap();
    api.revoked.store(true, Ordering::SeqCst);
    assert!(matches!(
        broker.synchronize(Some(view.generation)).await,
        Err(Error::Credentials)
    ));
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
    assert_eq!(broker.status().unwrap().state, "anonymous");
}
#[tokio::test]
async fn stale_user_commands_cannot_store_or_send_another_users_draft() {
    let api = Api::new();
    let broker = api.broker();
    let first = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    let previous = api.draft();
    broker.logout(Some(first.generation)).await.unwrap();
    {
        let mut p = api.profile.lock().unwrap();
        p.user.id = Uuid::new_v4();
        p.user.email = "bob@example.test".into();
        p.user.display_name = "Bob test".into();
    }
    let second = broker
        .login(
            "TEST".into(),
            "bob@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    assert!(matches!(
        broker.save_draft(previous, Some(first.generation)),
        Err(Error::SessionChanged)
    ));
    assert!(matches!(
        broker.synchronize(Some(first.generation)).await,
        Err(Error::SessionChanged)
    ));
    assert!(broker.drafts(Some(second.generation)).unwrap().is_empty());
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn identity_mismatch_prevents_transmitting_the_password() {
    let api = Api::new();
    let broker = api.broker();
    *api.deployment.lock().unwrap() = "other-server".into();
    assert!(matches!(
        broker
            .login(
                "TEST".into(),
                "alice@example.test".into(),
                Zeroizing::new("password-test".into())
            )
            .await,
        Err(Error::Identity)
    ));
    assert_eq!(api.logins.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_server_profile_purges_cached_data_instead_of_leaving_revalidation_pending() {
    let api = Api::new();
    let broker = api.broker();
    let view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    broker
        .save_draft(api.draft(), Some(view.generation))
        .unwrap();
    api.profile.lock().unwrap().authorization_version = 0;
    assert!(matches!(
        broker.revalidate(Some(view.generation)).await,
        Err(Error::InvalidResponse)
    ));
    assert_eq!(broker.status().unwrap().state, "anonymous");
    assert!(broker.drafts(Some(view.generation)).is_err());
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rotating_the_online_token_fences_commands_using_the_old_generation() {
    let api = Api::new();
    let broker = api.broker();
    let first = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    broker
        .save_draft(api.draft(), Some(first.generation))
        .unwrap();
    broker.lock(Some(first.generation)).await.unwrap();
    let next = broker
        .unlock(
            Zeroizing::new("password-test".into()),
            Some(first.generation),
        )
        .await
        .unwrap();
    assert!(next.generation > first.generation);
    assert!(matches!(
        broker.revalidate(Some(first.generation)).await,
        Err(Error::SessionChanged)
    ));
    assert_eq!(broker.drafts(Some(next.generation)).unwrap().len(), 1);
    assert_eq!(broker.status().unwrap().state, "online");
}

#[tokio::test]
async fn offline_unlock_requires_the_previous_users_password_and_keeps_a_fixed_expiry() {
    let api = Api::new();
    {
        let mut p = api.profile.lock().unwrap();
        p.permissions.push("offline:access".into());
        p.permissions.push("ledger:read".into());
        p.permissions.push("receipt:post".into());
        p.offline_until = Some(iso(wall_now() + 120000));
    }
    let broker = api.broker();
    let view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("local-password-test".into()),
        )
        .await
        .unwrap();
    let expiry = view.offline_until.clone();
    assert_eq!(
        broker.cash_catalog(Some(view.generation)).await.unwrap()["stale"],
        false
    );
    broker
        .save_draft(api.draft(), Some(view.generation))
        .unwrap();
    broker.lock(Some(view.generation)).await.unwrap();
    api.offline.store(true, Ordering::SeqCst);
    assert!(matches!(
        broker
            .unlock(Zeroizing::new("incorrect".into()), Some(view.generation))
            .await,
        Err(Error::Credentials)
    ));
    assert_eq!(broker.status().unwrap().state, "locked");
    let unlocked = broker
        .unlock(
            Zeroizing::new("local-password-test".into()),
            Some(view.generation),
        )
        .await
        .unwrap();
    assert_eq!(unlocked.state, "offline");
    assert_eq!(unlocked.offline_until, expiry);
    assert_eq!(broker.drafts(Some(view.generation)).unwrap().len(), 1);
    assert_eq!(
        broker.cash_catalog(Some(view.generation)).await.unwrap()["stale"],
        true
    );
    assert!(matches!(
        broker
            .cash_action(
                "confirm",
                Some(json!({"id":Uuid::new_v4(),"expectedVersion":1,"received":true})),
                Some(view.generation)
            )
            .await,
        Err(Error::OnlineRequired)
    ));
    assert!(matches!(
        broker
            .cash_action(
                "open",
                Some(json!({"id":Uuid::new_v4()})),
                Some(view.generation)
            )
            .await,
        Err(Error::OnlineRequired)
    ));
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn financial_confirmation_checks_identity_before_sending_any_post() {
    let api = Api::new();
    api.profile
        .lock()
        .unwrap()
        .permissions
        .push("receipt:post".into());
    let broker = api.broker();
    let view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    *api.deployment.lock().unwrap() = "wrong-deployment".into();
    assert!(matches!(
        broker
            .cash_action(
                "confirm",
                Some(json!({"id":Uuid::new_v4(),"expectedVersion":1,"received":true})),
                Some(view.generation)
            )
            .await,
        Err(Error::Identity)
    ));
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
    assert_eq!(broker.status().unwrap().state, "anonymous");
}
