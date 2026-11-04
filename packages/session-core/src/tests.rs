use super::*;
use crate::state::{iso, wall_now, Session, State, Verifier};
use serde_json::json;
use uuid::Uuid;
use zeroize::Zeroizing;
fn profile(now: i64) -> Profile {
    serde_json::from_value(json!({"sessionId":Uuid::new_v4(),"deviceId":Uuid::new_v4(),"user":{"id":Uuid::new_v4(),"email":"test@example.test","displayName":"Utilisateur test","mustChangePassword":false},"company":{"id":Uuid::new_v4(),"code":"TEST","name":"Entreprise test"},"roles":["CASHIER"],"permissions":["offline:access","draft:write_own","draft:read_own","ledger:read"],"agencies":[{"id":Uuid::new_v4(),"code":"A","name":"Agence A"}],"cashRegisters":[],"expiresAt":iso(now+3600000),"idleExpiresAt":iso(now+900000),"offlineUntil":iso(now+900000),"validatedAt":iso(now),"locked":false,"authorizationVersion":1})).unwrap()
}
fn session(now: i64) -> Session {
    Session::new(Zeroizing::new("a".repeat(43)), profile(now), None, now).unwrap()
}
fn draft(s: &Session, now: i64) -> SaveDraft {
    SaveDraft {
        draft: Draft {
            id: Uuid::new_v4(),
            kind: "expense-request".into(),
            currency: "USD".into(),
            amount: "12.34".into(),
            description: "Brouillon privé".into(),
            created_at: iso(now),
            expires_at: iso(now + 600000),
        },
        agency_id: s.profile.agencies[0].id,
        cash_register_id: None,
        expected_version: None,
    }
}
#[test]
fn unauthenticated_process_has_no_offline_access() {
    let mut state = State::default();
    let view = state.view(wall_now());
    assert_eq!(view.state, "anonymous");
    assert!(view.profile.is_none());
    assert!(view.offline_until.is_none());
}
#[test]
fn view_never_serializes_tokens_or_local_password_verifiers() {
    let now = wall_now();
    let mut state = State {
        session: Some(session(now)),
        ..Default::default()
    };
    let value = serde_json::to_string(&state.view(now)).unwrap();
    assert!(!value.contains(&"a".repeat(43)));
    assert!(!value.contains("accessToken"));
    assert!(!value.contains("password"));
}
#[test]
fn idle_lock_hides_profile_and_denies_reading_drafts() {
    let now = wall_now();
    let mut state = State {
        session: Some(session(now)),
        ..Default::default()
    };
    let input = draft(state.session.as_ref().unwrap(), now);
    state
        .session
        .as_mut()
        .unwrap()
        .save_draft(input, now)
        .unwrap();
    let view = state.view(now + 300000);
    assert_eq!(view.state, "locked");
    assert!(view.profile.is_none());
    assert!(matches!(
        state.session.as_mut().unwrap().list_drafts(now + 300000),
        Err(Error::Locked)
    ));
}
#[test]
fn expired_offline_lease_purges_the_scope_and_cannot_be_extended_by_activity() {
    let now = wall_now();
    let mut s = session(now);
    s.online = false;
    s.last_activity = now + 899000;
    let mut state = State {
        session: Some(s),
        ..Default::default()
    };
    assert_eq!(state.view(now + 899999).state, "offline");
    assert_eq!(state.view(now + 900000).state, "anonymous");
    assert!(state.session.is_none());
}
#[test]
fn changing_user_drops_the_previous_users_drafts() {
    let now = wall_now();
    let mut first = session(now);
    let record = first.save_draft(draft(&first, now), now).unwrap();
    let mut state = State {
        session: Some(first),
        ..Default::default()
    };
    let generation = state.generation;
    state.clear("LOGGED_OUT");
    state.session = Some(session(now));
    assert!(state.generation > generation);
    assert!(state
        .session
        .as_mut()
        .unwrap()
        .list_drafts(now)
        .unwrap()
        .iter()
        .all(|r| r.draft.id != record.draft.id));
}
#[test]
fn drafts_require_current_permissions_and_assigned_scope() {
    let now = wall_now();
    let mut s = session(now);
    let mut value = draft(&s, now);
    value.agency_id = Uuid::new_v4();
    assert!(matches!(s.save_draft(value, now), Err(Error::Forbidden)));
    let value = draft(&s, now);
    s.profile.permissions.retain(|p| p != "draft:write_own");
    assert!(matches!(s.save_draft(value, now), Err(Error::Forbidden)));
}
#[test]
fn drafts_have_stable_ids_exact_amounts_and_optimistic_versions() {
    let now = wall_now();
    let mut s = session(now);
    let input = draft(&s, now);
    let record = s.save_draft(input.clone(), now).unwrap();
    assert_eq!(record.version, 1);
    assert_eq!(record.draft.amount, "12.34");
    assert!(matches!(
        s.save_draft(input.clone(), now),
        Err(Error::Conflict)
    ));
    let mut edited = input;
    edited.expected_version = Some(1);
    edited.draft.amount = "12.35".into();
    assert_eq!(s.save_draft(edited, now).unwrap().version, 2);
}
#[test]
fn offline_access_is_denied_without_an_explicit_server_permission() {
    let now = wall_now();
    let mut p = profile(now);
    p.permissions.retain(|v| v != "offline:access");
    assert!(Session::new(Zeroizing::new("a".repeat(43)), p, None, now).is_err());
}
#[test]
fn invalid_or_extended_server_lease_is_rejected() {
    let now = wall_now();
    let mut p = profile(now);
    p.offline_until = Some(iso(now + 900001));
    assert!(Session::new(Zeroizing::new("a".repeat(43)), p, None, now).is_err());
}
#[test]
fn local_unlock_verifier_checks_password_without_storing_it() {
    let verifier = Verifier::create("Phrase-de-test-uniquement-2026").unwrap();
    assert!(verifier.verify("Phrase-de-test-uniquement-2026").unwrap());
    assert!(!verifier.verify("incorrect").unwrap());
}
#[test]
fn production_refuses_plain_http_and_urls_containing_credentials() {
    assert!(Broker::new("http://127.0.0.1:3000", "test", Uuid::new_v4(), false).is_err());
    assert!(Broker::new("http://example.test", "test", Uuid::new_v4(), true).is_err());
    assert!(Broker::new(
        "https://user:password@example.test",
        "test",
        Uuid::new_v4(),
        false
    )
    .is_err());
}
#[tokio::test]
async fn synchronization_cannot_start_without_an_authorized_session() {
    let broker = Broker::new("http://127.0.0.1:1", "test", Uuid::new_v4(), true).unwrap();
    assert!(matches!(
        broker.synchronize(None).await,
        Err(Error::AuthRequired)
    ));
}
