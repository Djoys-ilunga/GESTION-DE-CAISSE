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
#[derive(Default)]
struct SyncControl {
    delay_ms: AtomicUsize,
    drop_reply: AtomicBool,
    fail_before: AtomicBool,
    invalid_reply: AtomicBool,
    conflict_next: AtomicBool,
    requests: Mutex<Vec<Value>>,
    stored: Mutex<Option<Value>>,
    financial: AtomicUsize,
}
struct Api {
    sync: Arc<SyncControl>,
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
        let sync = Arc::new(SyncControl::default());
        let control = sync.clone();
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
                    Ok((stream, _)) => {
                        Self::reply(stream, &p, (&r, &offline_flag), &w, &l, &d, &control)
                    }
                    Err(_) => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self {
            sync,
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
        flags: (&AtomicBool, &AtomicBool),
        writes: &AtomicUsize,
        logins: &AtomicUsize,
        deployment: &Mutex<String>,
        sync: &SyncControl,
    ) {
        let (revoked, offline) = flags;
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
                json!({"service":"caissepro-api","status":"ready","protocolVersion":2,"deploymentId":deployment.lock().unwrap().as_str()}),
            ),
            "/api/v1/exchange-rates/quote" => (
                409,
                json!({"code":"BCC_AUTHORIZATION_REQUIRED","message":"Source non autorisée"}),
            ),
            "/api/v1/money/context" => (
                200,
                json!({"companyCurrencies":[{"code":"JPY","active":true,"version":1}],"preferences":{"favoriteCurrency":"JPY","displayCurrency":null,"locale":"fr-FR","version":1}}),
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
                sync.financial.fetch_add(1, Ordering::SeqCst);
                (201, json!({"ok":true}))
            }
            path if path.starts_with("/api/v1/expenses/")
                && (path.ends_with("/submit")
                    || path.ends_with("/decision")
                    || path.ends_with("/pay")) =>
            {
                writes.fetch_add(1, Ordering::SeqCst);
                sync.financial.fetch_add(1, Ordering::SeqCst);
                (201, json!({"ok":true}))
            }
            "/api/v1/auth/unlock" => (
                201,
                json!({"accessToken":"b".repeat(43),"profile":*p.lock().unwrap()}),
            ),
            path if path.starts_with("/api/v1/workspace/sync/drafts/") => {
                let stored = sync.stored.lock().unwrap();
                let b = stored.as_ref().unwrap();
                (
                    200,
                    json!({"serverId":b["draft"]["id"],"clientDraftId":b["draft"]["id"],"agencyId":b["agencyId"],"cashRegisterId":b["cashRegisterId"],"kind":b["draft"]["kind"],"version":b["version"],"createdAt":b["originalCreatedAt"],"updatedAt":b["updatedAt"],"receivedAt":iso(wall_now()),"sourceState":"draft","receiptId":null,"expenseRequestId":null,"currency":b["draft"]["currency"],"amount":b["draft"]["amount"],"description":b["draft"]["description"],"receiptDetails":b["draft"].get("receiptDetails"),"expenseDetails":b["draft"].get("expenseDetails")}),
                )
            }
            "/api/v1/transfers/drafts" => {
                let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                sync.requests.lock().unwrap().push(body.clone());
                *sync.stored.lock().unwrap() = Some(body.clone());
                if sync.drop_reply.swap(false, Ordering::SeqCst) {
                    return;
                }
                (201, json!({"id":body["id"],"state":"DRAFT"}))
            }
            path if path.starts_with("/api/v1/transfers/") => {
                writes.fetch_add(1, Ordering::SeqCst);
                sync.financial.fetch_add(1, Ordering::SeqCst);
                (201, json!({"ok":true}))
            }
            "/api/v1/workspace/drafts/sync" => {
                let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                sync.requests.lock().unwrap().push(body.clone());

                if sync.conflict_next.swap(false, Ordering::SeqCst) {
                    let body = "{}";
                    let _ = write!(
                        stream,
                        "HTTP/1.1 409 Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    return;
                }
                if sync.fail_before.load(Ordering::SeqCst) {
                    return;
                }
                writes.fetch_add(1, Ordering::SeqCst);
                *sync.stored.lock().unwrap() = Some(body.clone());
                thread::sleep(Duration::from_millis(
                    sync.delay_ms.load(Ordering::SeqCst) as u64
                ));
                if sync.drop_reply.swap(false, Ordering::SeqCst) {
                    return;
                }
                if sync.invalid_reply.load(Ordering::SeqCst) {
                    let body = "{}";
                    let _ = write!(
                        stream,
                        "HTTP/1.1 201 Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    return;
                }
                (
                    201,
                    json!({"draftId":body["draft"]["id"],"outcome":"accepted-as-draft","code":"draft-received","serverId":body["draft"]["id"],"serverVersion":body["version"],"synchronizedAt":iso(wall_now()),"sourceState":"draft","receiptId":null,"expenseRequestId":null}),
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
                expense_details: None,
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
    for action in ["send", "handover", "receive"] {
        assert!(matches!(broker.transfer_action(action, Some(json!({"id":Uuid::new_v4(),"expectedVersion":1,"handedOver":true,"received":true})), Some(view.generation)).await, Err(Error::OnlineRequired)));
    }
    for action in ["snapshot", "pdf", "xlsx", "close"] {
        assert!(matches!(
            broker
                .report_action(
                    action,
                    Some(json!({"confirmed":true})),
                    Some(view.generation)
                )
                .await,
            Err(Error::OnlineRequired)
        ));
    }
    for action in [
        "settings",
        "references",
        "supervision",
        "audit",
        "audit-pdf",
        "audit-xlsx",
        "company",
        "agency",
        "category",
        "rate",
    ] {
        assert!(matches!(
            broker
                .admin(
                    action,
                    Some(json!({"confirmed":true})),
                    Some(view.generation)
                )
                .await,
            Err(Error::OnlineRequired)
        ));
    }
    for action in ["submit", "decide", "pay", "configure"] {
        assert!(matches!(broker.expense_action(action,Some(json!({"id":Uuid::new_v4(),"expectedVersion":1,"paid":true,"submitted":true})),Some(view.generation)).await,Err(Error::OnlineRequired)));
    }
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

#[tokio::test]
async fn expense_payment_checks_attestation_permission_and_server_identity_before_posting() {
    let api = Api::new();
    api.profile
        .lock()
        .unwrap()
        .permissions
        .push("expense:pay".into());
    let broker = api.broker();
    let view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap();
    assert!(matches!(
        broker
            .expense_action(
                "pay",
                Some(json!({"id":Uuid::new_v4(),"expectedVersion":2,"paid":false})),
                Some(view.generation)
            )
            .await,
        Err(Error::InvalidInput)
    ));
    assert!(matches!(
        broker
            .expense_action(
                "decide",
                Some(json!({"id":Uuid::new_v4()})),
                Some(view.generation)
            )
            .await,
        Err(Error::Forbidden)
    ));
    *api.deployment.lock().unwrap() = "wrong-deployment".into();
    assert!(matches!(
        broker
            .expense_action(
                "pay",
                Some(json!({"id":Uuid::new_v4(),"expectedVersion":2,"paid":true})),
                Some(view.generation)
            )
            .await,
        Err(Error::Identity)
    ));
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
    assert_eq!(broker.status().unwrap().state, "anonymous");
}

async fn login_for_sync(broker: &Broker) -> u64 {
    broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("password-test".into()),
        )
        .await
        .unwrap()
        .generation
}
async fn wait_for_sync(api: &Api) {
    for _ in 0..200 {
        if !api.sync.requests.lock().unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("transmission did not start");
}
#[tokio::test]
async fn simultaneous_sends_use_one_worker_and_keep_newer_edits_after_the_ack() {
    let api = Api::new();
    let broker = Arc::new(api.broker());
    let generation = login_for_sync(&broker).await;
    let mut input = api.draft();
    let id = input.draft.id;
    broker.save_draft(input.clone(), Some(generation)).unwrap();
    api.sync.delay_ms.store(100, Ordering::SeqCst);
    let worker = broker.clone();
    let task = tokio::spawn(async move { worker.synchronize(Some(generation)).await });
    wait_for_sync(&api).await;
    assert!(matches!(
        broker.synchronize(Some(generation)).await,
        Err(Error::SyncBusy)
    ));
    input.expected_version = Some(1);
    input.draft.amount = "20.00".into();
    broker.save_draft(input, Some(generation)).unwrap();
    task.await.unwrap().unwrap();
    let r = broker.drafts(Some(generation)).unwrap().remove(0);
    assert_eq!(r.state, "queued");
    assert_eq!(r.server_version, Some(1));
    assert_eq!(r.version, 2);
    broker.synchronize(Some(generation)).await.unwrap();
    let requests = api.sync.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["draft"]["id"], id.to_string());
    assert_eq!(requests[1]["expectedServerVersion"], 1);
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn losing_the_reply_retries_the_exact_payload_only_after_explicit_unlock() {
    let api = Api::new();
    {
        let mut p = api.profile.lock().unwrap();
        p.permissions.push("offline:access".into());
        p.offline_until = Some(iso(wall_now() + 120000));
    }

    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    let input = api.draft();
    let id = input.draft.id;
    broker.save_draft(input, Some(generation)).unwrap();
    api.sync.drop_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        broker.synchronize(Some(generation)).await,
        Err(Error::Unavailable)
    ));
    assert_eq!(broker.status().unwrap().state, "locked");
    let next = broker
        .unlock(Zeroizing::new("password-test".into()), Some(generation))
        .await
        .unwrap()
        .generation;
    broker
        .synchronization_action(
            "retry",
            Some(json!({"id":id,"expectedVersion":1})),
            Some(next),
        )
        .await
        .unwrap();
    broker.synchronize(Some(next)).await.unwrap();
    {
        let requests = api.sync.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
    }
    assert_eq!(broker.drafts(Some(next)).unwrap()[0].state, "synced");
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn app_closure_has_no_plaintext_recovery_but_received_source_is_restorable() {
    let api = Api::new();
    let broker = Arc::new(api.broker());
    let generation = login_for_sync(&broker).await;
    let input = api.draft();
    let id = input.draft.id;
    let origin = input.draft.created_at.clone();
    broker.save_draft(input, Some(generation)).unwrap();
    api.sync.delay_ms.store(120, Ordering::SeqCst);
    let worker = broker.clone();
    let task = tokio::spawn(async move { worker.synchronize(Some(generation)).await });
    wait_for_sync(&api).await;
    task.abort();
    let _ = task.await;
    drop(broker);
    let next = api.broker();
    let generation = login_for_sync(&next).await;
    assert!(next.drafts(Some(generation)).unwrap().is_empty());
    let restored = next
        .synchronization_action("restore", Some(json!({"id":id})), Some(generation))
        .await
        .unwrap();
    assert_eq!(restored["draft"]["id"], id.to_string());
    assert_eq!(restored["originalCreatedAt"], origin);
    assert_eq!(restored["state"], "synced");
    next.synchronize(Some(generation)).await.unwrap();
    assert_eq!(api.sync.requests.lock().unwrap().len(), 1);
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn a_role_change_purges_scope_and_fences_pending_commands_before_sending() {
    let api = Api::new();
    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    broker.save_draft(api.draft(), Some(generation)).unwrap();
    {
        let mut p = api.profile.lock().unwrap();
        p.roles = vec!["AUDITOR".into()];
        p.authorization_version += 1;
    }
    assert!(matches!(
        broker.synchronize(Some(generation)).await,
        Err(Error::SessionChanged)
    ));
    let next = broker.status().unwrap().generation;
    assert!(next > generation);
    assert!(broker.drafts(Some(next)).unwrap().is_empty());
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn malformed_acknowledgement_purges_the_session_without_any_financial_replay() {
    let api = Api::new();
    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    broker.save_draft(api.draft(), Some(generation)).unwrap();
    api.sync.invalid_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        broker.synchronize(Some(generation)).await,
        Err(Error::InvalidResponse)
    ));
    assert_eq!(broker.status().unwrap().state, "anonymous");
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_cut_before_server_storage_preserves_the_same_draft_for_reconnection() {
    let api = Api::new();
    {
        let mut p = api.profile.lock().unwrap();
        p.permissions.push("offline:access".into());
        p.offline_until = Some(iso(wall_now() + 120000));
    }
    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    let input = api.draft();
    let id = input.draft.id;
    broker.save_draft(input, Some(generation)).unwrap();
    api.sync.fail_before.store(true, Ordering::SeqCst);
    assert!(matches!(
        broker.synchronize(Some(generation)).await,
        Err(Error::Unavailable)
    ));
    assert!(api.sync.stored.lock().unwrap().is_none());
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
    api.sync.fail_before.store(false, Ordering::SeqCst);
    let next = broker
        .unlock(Zeroizing::new("password-test".into()), Some(generation))
        .await
        .unwrap()
        .generation;
    broker
        .synchronization_action(
            "retry",
            Some(json!({"id":id,"expectedVersion":1})),
            Some(next),
        )
        .await
        .unwrap();
    broker.synchronize(Some(next)).await.unwrap();
    let requests = api.sync.requests.lock().unwrap();
    assert_eq!(requests[0], requests[1]);
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn native_conflict_resolution_rebases_explicitly_without_confirming_or_paying() {
    let api = Api::new();
    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    let mut input = api.draft();
    let id = input.draft.id;
    broker.save_draft(input.clone(), Some(generation)).unwrap();
    broker.synchronize(Some(generation)).await.unwrap();
    input.expected_version = Some(1);
    input.draft.amount = "20.00".into();
    broker.save_draft(input, Some(generation)).unwrap();
    {
        let mut stored = api.sync.stored.lock().unwrap();
        let v = stored.as_mut().unwrap();
        v["version"] = json!(2);
        v["draft"]["description"] = json!("Autre appareil");
    }
    api.sync.conflict_next.store(true, Ordering::SeqCst);
    let result = broker.synchronize(Some(generation)).await.unwrap();
    assert_eq!(result[0].outcome, "conflict");
    assert!(broker
        .synchronize(Some(generation))
        .await
        .unwrap()
        .is_empty());
    let revised = broker
        .synchronization_action(
            "resolve",
            Some(json!({"id":id,"expectedVersion":2,"choice":"local"})),
            Some(generation),
        )
        .await
        .unwrap();
    assert_eq!(revised["version"], 3);
    assert_eq!(revised["serverVersion"], 2);
    assert_eq!(revised["draft"]["amount"], "20.00");
    broker.synchronize(Some(generation)).await.unwrap();
    let requests = api.sync.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[2]["expectedServerVersion"], 2);
    assert_eq!(requests[2]["draft"]["id"], id.to_string());
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn a_late_ack_cannot_repopulate_data_after_logout() {
    let api = Api::new();
    let broker = Arc::new(api.broker());
    let generation = login_for_sync(&broker).await;
    broker.save_draft(api.draft(), Some(generation)).unwrap();
    api.sync.delay_ms.store(100, Ordering::SeqCst);
    let worker = broker.clone();
    let task = tokio::spawn(async move { worker.synchronize(Some(generation)).await });
    wait_for_sync(&api).await;
    broker.logout(Some(generation)).await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::SessionChanged)));
    assert_eq!(broker.status().unwrap().state, "anonymous");
    assert!(broker.drafts(None).is_err());
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn transfer_transmission_keeps_uuid_after_lost_ack_and_never_executes_a_financial_action() {
    let api = Api::new();
    let (source, destination, agency) = {
        let mut p = api.profile.lock().unwrap();
        p.permissions.push("offline:access".into());
        p.offline_until = Some(iso(wall_now() + 120000));
        let agency = p.agencies[0].id;
        let source = Uuid::new_v4();
        let destination = Uuid::new_v4();
        p.cash_registers = vec![
            crate::CashRegister {
                id: source,
                agency_id: agency,
                code: "A".into(),
                name: "Source".into(),
            },
            crate::CashRegister {
                id: destination,
                agency_id: agency,
                code: "B".into(),
                name: "Destination".into(),
            },
        ];
        (source, destination, agency)
    };
    let broker = api.broker();
    let mut view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("test-password".into()),
        )
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let quote_id = Uuid::new_v4();
    let input = json!({"id":id,"kind":"transfer","agencyId":agency,"cashRegisterId":source,"expectedLocalVersion":null,
        "fields":{"amount":"12.34","currency":"USD","destinationCurrency":"CDF","destinationCashRegisterId":destination.to_string(),"rate":"2800","rateSource":"Guichet","rateQuoteId":quote_id.to_string(),"description":"Transfert local"}});
    broker
        .synchronization_action("buffer-save", Some(input), Some(view.generation))
        .await
        .unwrap();
    api.sync.drop_reply.store(true, Ordering::SeqCst);
    assert!(broker
        .transfer_action("send", Some(json!({"id":id})), Some(view.generation))
        .await
        .is_err());
    assert_eq!(broker.status().unwrap().state, "locked");
    view = broker
        .unlock(
            Zeroizing::new("test-password".into()),
            Some(view.generation),
        )
        .await
        .unwrap();
    assert_eq!(
        broker
            .synchronization_action("buffers", None, Some(view.generation))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    broker.revalidate(Some(view.generation)).await.unwrap();
    let reply = broker
        .transfer_action("send", Some(json!({"id":id})), Some(view.generation))
        .await
        .unwrap();
    assert_eq!(reply["id"], id.to_string());
    {
        let requests = api.sync.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
        assert_eq!(requests[0]["rateQuoteId"], quote_id.to_string());
    }
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
    broker.logout(Some(view.generation)).await.unwrap();
    assert!(broker
        .transfer_action("send", Some(json!({"id":id})), Some(view.generation))
        .await
        .is_err());
}

#[tokio::test]
async fn transfer_confirmations_require_explicit_consent_and_revalidated_permissions() {
    let api = Api::new();
    api.profile
        .lock()
        .unwrap()
        .permissions
        .push("transfer:post".into());
    let broker = api.broker();
    let view = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("test-password".into()),
        )
        .await
        .unwrap();
    for action in ["handover", "receive"] {
        assert!(matches!(
            broker
                .transfer_action(
                    action,
                    Some(json!({"id":Uuid::new_v4(),"expectedVersion":1})),
                    Some(view.generation)
                )
                .await,
            Err(Error::InvalidInput)
        ));
    }
    api.profile
        .lock()
        .unwrap()
        .permissions
        .retain(|p| p != "transfer:post");
    assert!(broker.transfer_action("handover",Some(json!({"id":Uuid::new_v4(),"expectedVersion":1,"handedOver":true,"rateValidated":true})),Some(view.generation)).await.is_err());
    assert_eq!(api.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn currency_context_is_memory_only_guarded_offline_and_cannot_change_preferences_offline() {
    let api = Api::new();
    {
        let mut p = api.profile.lock().unwrap();
        p.permissions.push("offline:access".into());
        p.offline_until = Some(iso(wall_now() + 120000));
    }
    let broker = api.broker();
    let session = broker
        .login(
            "TEST".into(),
            "alice@example.test".into(),
            Zeroizing::new("local-password-test".into()),
        )
        .await
        .unwrap();
    let context = broker
        .admin("money-context", None, Some(session.generation))
        .await
        .unwrap();
    assert_eq!(context["companyCurrencies"][0]["code"], "JPY");
    api.offline.store(true, Ordering::SeqCst);
    let _ = broker.revalidate(Some(session.generation)).await;
    let session = broker
        .unlock(
            Zeroizing::new("local-password-test".into()),
            Some(session.generation),
        )
        .await
        .unwrap();
    assert_eq!(
        broker
            .admin("money-context", None, Some(session.generation))
            .await
            .unwrap(),
        context
    );
    assert!(matches!(
        broker
            .admin(
                "money-preferences",
                Some(json!({})),
                Some(session.generation)
            )
            .await,
        Err(Error::OnlineRequired)
    ));
    assert!(matches!(
        broker
            .admin(
                "money-currencies",
                Some(json!({"confirmed":true})),
                Some(session.generation)
            )
            .await,
        Err(Error::OnlineRequired)
    ));
    assert!(matches!(
        broker
            .transfer_action("handover", Some(json!({})), Some(session.generation))
            .await,
        Err(Error::OnlineRequired)
    ));
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
    broker.lock(Some(session.generation)).await.unwrap();
    assert!(matches!(
        broker
            .admin("money-context", None, Some(session.generation))
            .await,
        Err(Error::Locked)
    ));
}

#[tokio::test]
async fn exchange_access_is_online_permission_guarded_and_rejects_unconfirmed_refresh() {
    let api = Api::new();
    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    assert!(matches!(
        broker.admin("exchange-rates", None, Some(generation)).await,
        Err(Error::Forbidden)
    ));
    {
        let mut p = api.profile.lock().unwrap();
        p.permissions.push("cash:configure".into());
        p.permissions.push("ledger:read".into());
    }
    let generation = broker
        .revalidate(Some(generation))
        .await
        .unwrap()
        .generation;
    assert!(matches!(
        broker
            .admin(
                "exchange-refresh",
                Some(json!({"confirmed":false})),
                Some(generation)
            )
            .await,
        Err(Error::InvalidInput)
    ));
    broker.lock(Some(generation)).await.unwrap();
    assert!(matches!(
        broker
            .admin("exchange-quote", Some(json!({})), Some(generation))
            .await,
        Err(Error::Locked)
    ));
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn exchange_authorization_error_is_preserved_without_financial_action() {
    let api = Api::new();
    api.profile
        .lock()
        .unwrap()
        .permissions
        .push("ledger:read".into());
    let broker = api.broker();
    let generation = login_for_sync(&broker).await;
    assert!(matches!(
        broker
            .admin(
                "exchange-quote",
                Some(json!({"mode":"BCC"})),
                Some(generation)
            )
            .await,
        Err(Error::BccAuthorizationRequired)
    ));
    assert_eq!(api.sync.financial.load(Ordering::SeqCst), 0);
}
