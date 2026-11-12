use super::*;
use crate::state::{iso, wall_now, Session, State, Verifier};
use serde_json::json;
use uuid::Uuid;
use zeroize::Zeroizing;
#[test]
fn receipt_metadata_is_private_draft_data_and_a_confirmed_source_cannot_be_edited() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let cash = Uuid::new_v4();
    s.profile.cash_registers.push(CashRegister {
        id: cash,
        agency_id: s.profile.agencies[0].id,
        code: "C".into(),
        name: "Caisse".into(),
    });
    input.cash_register_id = Some(cash);
    input.draft.kind = "receipt".into();
    input.draft.receipt_details = Some(ReceiptDetails {
        provenance: "Payeur privé".into(),
        category: "Ventes".into(),
        reference: "R-1".into(),
        supporting_document: None,
    });
    let saved = s.save_draft(input.clone(), now).unwrap();
    assert_eq!(saved.draft.amount, "12.34");
    assert!(saved.receipt_number.is_none());
    s.drafts.get_mut(&saved.draft.id).unwrap().state = "confirmed".into();
    input.expected_version = Some(1);
    input.draft.amount = "99.00".into();
    assert!(matches!(s.save_draft(input, now), Err(Error::Conflict)));
    assert!(s.balances.is_none());
}
#[test]
fn forged_attachment_is_rejected_before_it_is_stored() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let cash = Uuid::new_v4();
    s.profile.cash_registers.push(CashRegister {
        id: cash,
        agency_id: s.profile.agencies[0].id,
        code: "C".into(),
        name: "Caisse".into(),
    });
    input.cash_register_id = Some(cash);
    input.draft.kind = "receipt".into();
    input.draft.receipt_details = Some(ReceiptDetails {
        provenance: "Payeur".into(),
        category: "Ventes".into(),
        reference: String::new(),
        supporting_document: Some(SupportingDocument {
            file_name: "faux.pdf".into(),
            mime_type: "application/pdf".into(),
            data_base64: "aHRtbA==".into(),
        }),
    });
    assert!(matches!(s.save_draft(input, now), Err(Error::InvalidInput)));
    assert!(s.drafts.is_empty());
}
fn profile(now: i64) -> Profile {
    serde_json::from_value(json!({"sessionId":Uuid::new_v4(),"deviceId":Uuid::new_v4(),"user":{"id":Uuid::new_v4(),"email":"test@example.test","displayName":"Utilisateur test","mustChangePassword":false},"company":{"id":Uuid::new_v4(),"code":"TEST","name":"Entreprise test"},"roles":["CASHIER"],"permissions":["offline:access","draft:write_own","draft:read_own","ledger:read"],"agencies":[{"id":Uuid::new_v4(),"code":"A","name":"Agence A"}],"cashRegisters":[],"expiresAt":iso(now+3600000),"idleExpiresAt":iso(now+900000),"offlineUntil":iso(now+900000),"validatedAt":iso(now),"locked":false,"authorizationVersion":1})).unwrap()
}
pub(crate) fn session(now: i64) -> Session {
    Session::new(Zeroizing::new("a".repeat(43)), profile(now), None, now).unwrap()
}
pub(crate) fn draft(s: &Session, now: i64) -> SaveDraft {
    SaveDraft {
        draft: Draft {
            receipt_details: None,
            expense_details: None,
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

#[test]
fn permission_scope_comparison_ignores_order_and_display_names() {
    let now = wall_now();
    let first = profile(now);
    let mut second = first.clone();
    second.permissions.reverse();
    second.agencies[0].name = "Agence renommée".into();
    assert!(first.same_scope(&second));
    second.permissions.clear();
    assert!(!first.same_scope(&second));
}

#[test]
fn expense_details_remain_drafts_and_are_isolated_until_expiry() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    input.draft.expense_details = Some(ExpenseDetails {
        category: None,
        beneficiary: "Bénéficiaire privé".into(),
        reference: "F-1".into(),
        documents: vec![],
    });
    let saved = s.save_draft(input.clone(), now).unwrap();
    assert_eq!(
        saved.draft.expense_details.unwrap().beneficiary,
        "Bénéficiaire privé"
    );
    assert_eq!(saved.state, "local");
    assert!(saved.submitted_expense_id.is_none());
    assert!(s.balances.is_none());
    assert!(session(now).list_drafts(now).unwrap().is_empty());
    assert!(matches!(s.list_drafts(now + 600001), Err(Error::Locked)));
    s.last_activity = now + 600001;
    assert!(s.list_drafts(now + 600001).unwrap().is_empty());
}
#[test]
fn submitted_expense_draft_cannot_be_changed_or_reassigned() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let saved = s.save_draft(input.clone(), now).unwrap();
    let record = s.drafts.get_mut(&saved.draft.id).unwrap();
    record.state = "submitted".into();
    record.submitted_expense_id = Some(Uuid::new_v4());
    input.expected_version = Some(1);
    input.draft.amount = "99.99".into();
    assert!(matches!(s.save_draft(input, now), Err(Error::Conflict)));
    assert_eq!(s.list_drafts(now).unwrap()[0].draft.amount, "12.34");
}
#[test]
fn expense_draft_rejects_forged_or_excessive_evidence_before_storage() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let document = SupportingDocument {
        file_name: "facture.pdf".into(),
        mime_type: "application/pdf".into(),
        data_base64: "aHRtbA==".into(),
    };
    input.draft.expense_details = Some(ExpenseDetails {
        category: None,
        beneficiary: "Fournisseur".into(),
        reference: String::new(),
        documents: vec![document.clone()],
    });
    assert!(matches!(
        s.save_draft(input.clone(), now),
        Err(Error::InvalidInput)
    ));
    input.draft.expense_details.as_mut().unwrap().documents = vec![document; 4];
    assert!(matches!(s.save_draft(input, now), Err(Error::InvalidInput)));
    assert!(s.drafts.is_empty());
}

fn sync_ack(pending: &PendingSync, now: i64) -> SyncResult {
    let mut value = SyncResult::failure(
        pending.record.draft.id,
        "accepted-as-draft",
        "draft-received",
    );
    value.server_id = Some(Uuid::new_v4());
    value.server_version = Some(pending.record.version);
    value.synchronized_at = Some(iso(now));
    value.source_state = Some("draft".into());
    value
}
#[test]
fn synchronization_keeps_acknowledgement_when_user_edits_during_transmission() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input.clone(), now).unwrap();
    let pending = s.prepare_sync(id, now).unwrap().unwrap();
    input.expected_version = Some(1);
    input.draft.description = "Correction pendant la transmission".into();
    s.save_draft(input, now + 10).unwrap();
    let response = sync_ack(&pending, now + 20);
    let server = response.server_id;
    s.finish_sync(&pending, response, now + 20).unwrap();
    let current = s.drafts.get(&id).unwrap();
    assert_eq!(current.version, 2);
    assert_eq!(current.server_version, Some(1));
    assert_eq!(current.server_id, server);
    assert_eq!(current.state, "queued");
    let next = s.prepare_sync(id, now + 30).unwrap().unwrap();
    assert_eq!(next.record.version, 2);
    assert_eq!(next.record.server_version, Some(1));
    assert_eq!(
        next.record.draft.description,
        "Correction pendant la transmission"
    );
}
#[test]
fn lost_reply_preserves_the_exact_pending_payload_before_a_newer_local_revision() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input.clone(), now).unwrap();
    let first = s.prepare_sync(id, now).unwrap().unwrap();
    s.finish_sync(
        &first,
        SyncResult::failure(id, "deferred", "transport-error"),
        now,
    )
    .unwrap();
    input.expected_version = Some(1);
    input.draft.amount = "99.99".into();
    s.save_draft(input, now + 100).unwrap();
    assert!(s.prepare_sync(id, now + 200).unwrap().is_none());
    let retried = s.prepare_sync(id, now + 5000).unwrap().unwrap();
    assert!(retried.record.draft == first.record.draft);
    assert_eq!(retried.record.version, first.record.version);
    assert_eq!(retried.record.updated_at, first.record.updated_at);
    assert_eq!(retried.record.server_version, first.record.server_version);
}
#[test]
fn attempts_are_bounded_and_throttling_waits_at_least_one_minute() {
    let now = wall_now();
    let mut s = session(now);
    let input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input, now).unwrap();
    let mut at = now;
    for attempt in 1..=5 {
        let pending = s.prepare_sync(id, at).unwrap().unwrap();
        s.finish_sync(
            &pending,
            SyncResult::failure(id, "deferred", "rate-limited"),
            at,
        )
        .unwrap();
        let record = s.drafts.get(&id).unwrap();
        assert_eq!(record.attempts, attempt);
        let next = crate::state::millis(record.next_attempt_at.as_ref().unwrap()).unwrap();
        assert!(next - at >= 60000);
        at = next;
        s.last_activity = at;
    }
    assert_eq!(s.drafts.get(&id).unwrap().state, "error");
    assert!(s.prepare_sync(id, at).unwrap().is_none());
}
#[test]
fn conflicts_stop_automatic_sending_without_modifying_any_financial_cache() {
    let now = wall_now();
    let mut s = session(now);
    let input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input, now).unwrap();
    s.balances = Some(json!({"marker":"official-cache-unchanged"}));
    let pending = s.prepare_sync(id, now).unwrap().unwrap();
    s.finish_sync(
        &pending,
        SyncResult::failure(id, "conflict", "conflict"),
        now,
    )
    .unwrap();
    assert_eq!(s.drafts.get(&id).unwrap().state, "conflict");
    assert!(s.prepare_sync(id, now + 1000).unwrap().is_none());
    assert_eq!(
        s.balances,
        Some(json!({"marker":"official-cache-unchanged"}))
    );
}
#[test]
fn canceling_a_transmission_can_resume_the_same_pending_snapshot() {
    let now = wall_now();
    let mut s = session(now);
    let input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input, now).unwrap();
    let abandoned = s.prepare_sync(id, now).unwrap().unwrap();
    assert_eq!(s.drafts.get(&id).unwrap().state, "syncing");
    let resumed = s.prepare_sync(id, now + 1).unwrap().unwrap();
    assert!(resumed.record.draft == abandoned.record.draft);
    s.finish_sync(&resumed, sync_ack(&resumed, now + 2), now + 2)
        .unwrap();
    assert!(s.prepare_sync(id, now + 3).unwrap().is_none());
}
#[test]
fn expiry_removes_pending_sensitive_snapshots_and_a_new_session_has_no_unsent_data() {
    let now = wall_now();
    let mut s = session(now);
    let input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input, now).unwrap();
    s.prepare_sync(id, now).unwrap();
    assert!(session(now).drafts.is_empty());
    assert!(session(now).pending_sync.is_empty());
    s.last_activity = now + 600001;
    s.list_drafts(now + 600001).unwrap();
    assert!(s.drafts.is_empty());
    assert!(s.pending_sync.is_empty());
}
#[test]
fn a_finalized_source_never_discards_a_newer_local_correction_or_becomes_a_payment() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = draft(&s, now);
    let id = input.draft.id;
    s.save_draft(input.clone(), now).unwrap();
    let pending = s.prepare_sync(id, now).unwrap().unwrap();
    input.expected_version = Some(1);
    input.draft.amount = "99.99".into();
    s.save_draft(input.clone(), now + 1).unwrap();
    let mut response = sync_ack(&pending, now + 2);
    response.source_state = Some("submitted".into());
    response.expense_request_id = Some(Uuid::new_v4());
    s.finish_sync(&pending, response, now + 2).unwrap();
    assert_eq!(s.drafts.get(&id).unwrap().state, "conflict");
    assert_eq!(s.drafts.get(&id).unwrap().draft.amount, "99.99");
    input.expected_version = Some(2);
    assert!(matches!(s.save_draft(input, now + 3), Err(Error::Conflict)));
    assert!(s.balances.is_none());
}

fn input_buffer(s: &Session) -> FormBufferInput {
    FormBufferInput {
        id: Uuid::new_v4(),
        kind: "expense-request".into(),
        agency_id: s.profile.agencies[0].id,
        cash_register_id: None,
        expected_local_version: None,
        fields: std::collections::HashMap::from([
            ("amount".into(), "12,".into()),
            ("beneficiary".into(), "Bénéficiaire privé".into()),
        ]),
    }
}
#[test]
fn interrupted_incomplete_input_is_isolated_locked_and_never_a_transmittable_draft() {
    let now = wall_now();
    let mut s = session(now);
    let input = input_buffer(&s);
    let captured = s.save_form_buffer(input.clone(), now).unwrap();
    assert!(s.list_drafts(now).unwrap().is_empty());
    assert!(s.balances.is_none());
    assert_eq!(s.list_form_buffers(now).unwrap()[0].fields["amount"], "12,");
    s.locked = true;
    assert!(matches!(s.list_form_buffers(now), Err(Error::Locked)));
    s.locked = false;
    assert_eq!(s.list_form_buffers(now).unwrap()[0].id, captured.id);
    assert!(session(now).list_form_buffers(now).unwrap().is_empty());
    assert!(matches!(
        s.save_form_buffer(
            FormBufferInput {
                agency_id: Uuid::new_v4(),
                ..input
            },
            now
        ),
        Err(Error::Forbidden)
    ));
}
#[test]
fn incomplete_input_cannot_extend_its_lease_or_survive_source_expiration() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = input_buffer(&s);
    let mut d = draft(&s, now);
    d.draft.expires_at = iso(now + 10000);
    input.id = d.draft.id;
    s.save_draft(d, now).unwrap();
    input.expected_local_version = Some(1);
    let first = s.save_form_buffer(input.clone(), now).unwrap();
    assert_eq!(first.expires_at, iso(now + 10000));
    assert_eq!(
        s.save_form_buffer(input, now + 1000).unwrap().expires_at,
        first.expires_at
    );
    assert!(s.list_form_buffers(now + 10001).unwrap().is_empty());
}
#[test]
fn validated_save_consumes_its_input_buffer_and_bounds_private_fields() {
    let now = wall_now();
    let mut s = session(now);
    let mut input = input_buffer(&s);
    input
        .fields
        .insert("accessToken".into(), "forbidden".into());
    assert!(matches!(
        s.save_form_buffer(input.clone(), now),
        Err(Error::InvalidInput)
    ));
    input.fields.remove("accessToken");
    let mut d = draft(&s, now);
    d.draft.id = input.id;
    s.save_form_buffer(input, now).unwrap();
    s.save_draft(d, now).unwrap();
    assert!(s.form_buffers.is_empty());
    assert_eq!(s.list_drafts(now).unwrap().len(), 1);
}

#[test]
fn multicurrency_offline_drafts_keep_their_exact_original_units_without_posting() {
    let now = wall_now();
    let mut s = session(now);
    s.online = false;
    s.money_context = Some(
        json!({"currencies":[{"code":"JPY","precision":0},{"code":"KWD","precision":3},{"code":"CLF","precision":4},{"code":"EUR","precision":2}]}),
    );
    for (currency, amount) in [("JPY", "123"), ("KWD", "0.001"), ("CLF", "12.3456")] {
        let mut input = draft(&s, now);
        input.draft.currency = currency.into();
        input.draft.amount = amount.into();
        let saved = s.save_draft(input, now).unwrap();
        assert_eq!(saved.draft.currency, currency);
        assert_eq!(saved.draft.amount, amount);
        assert!(s.balances.is_none());
    }
    for (currency, amount) in [
        ("jpy", "1"),
        ("JPY", "1.00"),
        ("KWD", "1.00"),
        ("EUR", "1.00001"),
        ("EUR", "0.0000"),
        ("EUR", "1e2"),
    ] {
        let mut input = draft(&s, now);
        input.draft.currency = currency.into();
        input.draft.amount = amount.into();
        assert!(s.save_draft(input, now).is_err());
    }
}
