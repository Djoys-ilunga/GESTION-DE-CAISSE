use super::*;
use crate::{
    state::{iso, wall_now},
    tests::{draft, session},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[derive(Default)]
pub(crate) struct TestVault {
    pub values: Mutex<HashMap<String, Vec<u8>>>,
    pub fail_writes: AtomicBool,
    pub fail_deletes: AtomicBool,
}
impl KeyVault for TestVault {
    fn load(
        &self,
        a: &str,
    ) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, caissepro_local_store::StoreError> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(a)
            .cloned()
            .map(Zeroizing::new))
    }
    fn store(
        &self,
        a: &str,
        k: &[u8],
    ) -> std::result::Result<(), caissepro_local_store::StoreError> {
        if self.fail_writes.load(Ordering::SeqCst) {
            return Err(caissepro_local_store::StoreError::KeyUnavailable);
        }
        self.values.lock().unwrap().insert(a.into(), k.to_vec());
        Ok(())
    }
    fn delete(&self, a: &str) -> std::result::Result<(), caissepro_local_store::StoreError> {
        if self.fail_deletes.load(Ordering::SeqCst) {
            return Err(caissepro_local_store::StoreError::KeyUnavailable);
        }
        self.values.lock().unwrap().remove(a);
        Ok(())
    }
}
const PASSWORD: &str = "Mot-de-passe-synthetique!13B";
fn setup() -> (tempfile::TempDir, Arc<Runtime>, Arc<TestVault>, Session) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(TestVault::default());
    let runtime = Runtime::for_tests(
        dir.path().join("sealed"),
        "https://caissepro.example.test/",
        vault.clone(),
    )
    .unwrap();
    let mut s = session(wall_now());
    s.profile.device_id = runtime.device;
    s.verifier = Some(Verifier::create(PASSWORD).unwrap());
    (dir, runtime, vault, s)
}
fn path(runtime: &Runtime) -> PathBuf {
    fs::read_dir(&runtime.root)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}
#[test]
fn sqlcipher_checkpoint_reopens_locked_with_stable_device_and_without_bearer_token() {
    let (dir, runtime, vault, mut s) = setup();
    let now = wall_now();
    let mut d = draft(&s, now);
    d.draft.expires_at = iso(now + DRAFT_RETENTION_MS);
    let id = d.draft.id;
    s.save_draft(d, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    let sealed = fs::read(path(&runtime)).unwrap();
    assert!(!sealed.starts_with(b"SQLite format 3"));
    assert!(!sealed.windows(9).any(|b| b == b"Brouillon"));
    let bytes = s
        .durable
        .as_ref()
        .unwrap()
        .store
        .as_ref()
        .unwrap()
        .read_checkpoint()
        .unwrap()
        .unwrap()
        .1;
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(!text.contains(&"a".repeat(43)));
    assert!(!text.contains(PASSWORD));
    assert!(!text.contains("accessToken"));
    let device = runtime.device;
    drop(s);
    drop(runtime);
    let runtime = Runtime::for_tests(
        dir.path().join("sealed"),
        "https://caissepro.example.test/",
        vault,
    )
    .unwrap();
    assert_eq!(runtime.device, device);
    let mut restored = runtime.restore(wall_now()).unwrap().unwrap();
    assert!(restored.locked);
    assert!(!restored.online);
    assert!(restored.token.is_empty());
    assert!(matches!(
        restored.list_drafts(wall_now()),
        Err(Error::Locked)
    ));
    assert_eq!(restored.drafts[&id].draft.amount, "12.34");
    assert!(restored
        .verifier
        .as_ref()
        .unwrap()
        .verify(PASSWORD)
        .unwrap());
}
#[test]
fn expired_offline_lease_preserves_sealed_drafts_until_fresh_authorized_login() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    s.offline_until = now + 3000;
    s.profile.offline_until = Some(iso(s.offline_until));
    let mut d = draft(&s, now);
    d.draft.expires_at = iso(now + DRAFT_RETENTION_MS);
    let id = d.draft.id;
    s.save_draft(d, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    let profile = s.profile.clone();
    drop(s);
    assert!(runtime.restore(now + 3001).unwrap().is_none());
    let mut fresh = Session::new(
        Zeroizing::new("b".repeat(43)),
        profile,
        Some(Verifier::create(PASSWORD).unwrap()),
        now,
    )
    .unwrap();
    runtime.attach(&mut fresh, wall_now()).unwrap();
    assert!(fresh.drafts.contains_key(&id));
}
#[test]
fn logout_disables_offline_reopen_but_does_not_destroy_authorized_drafts() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    let d = draft(&s, now);
    let id = d.draft.id;
    s.save_draft(d, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    s.detach_storage("LOGGED_OUT").unwrap();
    assert!(runtime.restore(wall_now()).unwrap().is_none());
    runtime.attach(&mut s, wall_now()).unwrap();
    assert!(s.drafts.contains_key(&id));
}
#[test]
fn other_user_and_company_never_receive_the_previous_workspace() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    let d = draft(&s, now);
    s.save_draft(d, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    let mut other = session(now);
    other.profile.device_id = runtime.device;
    other.verifier = Some(Verifier::create(PASSWORD).unwrap());
    runtime.attach(&mut other, now).unwrap();
    assert!(other.drafts.is_empty());
    assert!(other.form_buffers.is_empty());
    assert_eq!(
        runtime
            .restore(wall_now())
            .unwrap()
            .unwrap()
            .profile
            .user
            .id,
        other.profile.user.id
    );
}
#[test]
fn changed_permissions_destroy_the_old_scope_before_attaching_the_new_one() {
    let (_dir, runtime, vault, mut s) = setup();
    let now = wall_now();
    let d = draft(&s, now);
    s.save_draft(d, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    let mut p = s.profile.clone();
    p.authorization_version += 1;
    p.permissions.retain(|v| v != "draft:write_own");
    drop(s);
    let mut fresh = Session::new(
        Zeroizing::new("b".repeat(43)),
        p,
        Some(Verifier::create(PASSWORD).unwrap()),
        now,
    )
    .unwrap();
    runtime.attach(&mut fresh, now).unwrap();
    assert!(fresh.drafts.is_empty());
    assert!(vault.values.lock().unwrap().len() >= 2);
    let restored = runtime.restore(wall_now()).unwrap().unwrap();
    assert!(restored.drafts.is_empty());
}
#[test]
fn exact_pending_payload_and_newer_local_edit_survive_a_restart() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    let d = draft(&s, now);
    let id = d.draft.id;
    s.save_draft(d.clone(), now).unwrap();
    let pending = s.prepare_sync(id, now).unwrap().unwrap();
    let exact = serde_json::to_value(&pending.record).unwrap();
    let mut edit = d;
    edit.expected_version = Some(1);
    edit.draft.amount = "99.00".into();
    s.save_draft(edit, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    drop(s);
    let restored = runtime.restore(wall_now()).unwrap().unwrap();
    assert_eq!(restored.drafts[&id].version, 2);
    assert_eq!(restored.drafts[&id].draft.amount, "99.00");
    assert_eq!(
        serde_json::to_value(&restored.pending_sync[&id].record).unwrap(),
        exact
    );
}
#[test]
fn incomplete_transfer_and_sync_server_links_are_preserved_without_execution() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    let d = draft(&s, now);
    let id = d.draft.id;
    s.save_draft(d, now).unwrap();
    let server = Uuid::new_v4();
    let r = s.drafts.get_mut(&id).unwrap();
    r.server_id = Some(server);
    r.server_version = Some(1);
    r.state = "synced".into();
    let transfer = Uuid::new_v4();
    s.save_form_buffer(
        FormBufferInput {
            id: transfer,
            kind: "transfer".into(),
            agency_id: s.profile.agencies[0].id,
            cash_register_id: None,
            expected_local_version: None,
            fields: HashMap::from([
                ("currency".into(), "USD".into()),
                ("destinationCurrency".into(), "CDF".into()),
                ("amount".into(), "2.00".into()),
                ("rateMode".into(), "MANUAL".into()),
                ("rate".into(), "2500".into()),
            ]),
        },
        now,
    )
    .unwrap();
    runtime.attach(&mut s, now).unwrap();
    drop(s);
    let restored = runtime.restore(wall_now()).unwrap().unwrap();
    assert_eq!(restored.form_buffers[&transfer].fields["rate"], "2500");
    assert_eq!(restored.drafts[&id].server_id, Some(server));
    assert!(restored.drafts[&id].confirmed_receipt_id.is_none());
}
#[test]
fn sqlcipher_corruption_is_refused_without_replacing_the_file() {
    let (_dir, runtime, _vault, mut s) = setup();
    runtime.attach(&mut s, wall_now()).unwrap();
    let file = path(&runtime);
    drop(s);
    let corrupt = vec![0xA7; 4096];
    fs::write(&file, &corrupt).unwrap();
    assert!(runtime.restore(wall_now()).is_err());
    assert_eq!(fs::read(file).unwrap(), corrupt);
}
#[test]
fn missing_encryption_key_is_refused_without_generating_a_replacement() {
    let (_dir, runtime, vault, mut s) = setup();
    runtime.attach(&mut s, wall_now()).unwrap();
    let file = path(&runtime);
    let before = fs::read(&file).unwrap();
    drop(s);
    vault
        .values
        .lock()
        .unwrap()
        .retain(|key, _| key.starts_with("installation-") || key.starts_with("resume-"));
    assert!(runtime.restore(wall_now()).is_err());
    assert_eq!(fs::read(file).unwrap(), before);
}
#[test]
fn clock_rollback_and_replayed_checkpoint_are_rejected_for_offline_access() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    runtime.attach(&mut s, now).unwrap();
    let file = path(&runtime);
    let before = fs::read(&file).unwrap();
    assert!(runtime.restore(now - 1).unwrap().is_none());
    s.checkpoint(wall_now()).unwrap();
    drop(s);
    fs::write(&file, before).unwrap();
    assert!(runtime.restore(wall_now()).is_err());
}
#[test]
fn ticket_write_failure_does_not_confirm_an_offline_recoverable_save() {
    let (_dir, runtime, vault, mut s) = setup();
    runtime.attach(&mut s, wall_now()).unwrap();
    vault.fail_writes.store(true, Ordering::SeqCst);
    assert!(matches!(s.checkpoint(wall_now()), Err(Error::LocalStorage)));
    drop(s);
    vault.fail_writes.store(false, Ordering::SeqCst);
    assert!(runtime.restore(wall_now()).is_err());
}
#[test]
fn concurrent_process_checkpoint_uses_optimistic_revision_and_preserves_the_winner() {
    let (_dir, runtime, _vault, mut s) = setup();
    let now = wall_now();
    runtime.attach(&mut s, now).unwrap();
    let mut other = Session::new(
        Zeroizing::new("b".repeat(43)),
        s.profile.clone(),
        Some(Verifier::create(PASSWORD).unwrap()),
        now,
    )
    .unwrap();
    runtime.attach(&mut other, now).unwrap();
    assert!(matches!(s.checkpoint(wall_now()), Err(Error::LocalStorage)));
    assert!(s.detach_storage("SESSION_REVOKED").is_err());
    assert!(runtime.restore(wall_now()).unwrap().is_some());
}
#[test]
fn failed_ticket_deletion_still_invalidates_offline_resume_in_the_encrypted_database() {
    let (_dir, runtime, vault, mut s) = setup();
    runtime.attach(&mut s, wall_now()).unwrap();
    vault.fail_deletes.store(true, Ordering::SeqCst);
    assert!(s.detach_storage("LOGGED_OUT").is_err());
    vault.fail_deletes.store(false, Ordering::SeqCst);
    assert!(runtime.restore(wall_now()).is_err());
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn real_native_vault_sqlcipher_reopen_and_ticket_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = format!("https://{}.example.test/", Uuid::new_v4());
    let runtime = Runtime::for_tests(
        dir.path().join("sealed"),
        &endpoint,
        Arc::new(caissepro_local_store::NativeKeyVault),
    )
    .unwrap();
    let now = wall_now();
    let mut s = session(now);
    s.profile.device_id = runtime.device;
    s.verifier = Some(Verifier::create(PASSWORD).unwrap());
    let d = draft(&s, now);
    let id = d.draft.id;
    s.save_draft(d, now).unwrap();
    runtime.attach(&mut s, now).unwrap();
    drop(s);
    let mut restored = runtime.restore(wall_now()).unwrap().unwrap();
    assert!(restored.drafts.contains_key(&id));
    restored.detach_storage("SESSION_REVOKED").unwrap();
    assert!(runtime.restore(wall_now()).unwrap().is_none());
    runtime
        .vault
        .delete(&format!("installation-{}", runtime.namespace))
        .unwrap();
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn native_key_vault_and_sqlcipher_survive_a_real_process_restart() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = format!("https://{}.example.test/", Uuid::new_v4());
    for phase in ["write", "read"] {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "persistence::tests::native_process_storage_contract",
                "--nocapture",
            ])
            .env("CAISSEPRO_STORAGE_TEST_ROOT", dir.path())
            .env("CAISSEPRO_STORAGE_TEST_SERVER", &endpoint)
            .env("CAISSEPRO_STORAGE_TEST_PHASE", phase)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed"));
    }
    let runtime = Runtime::for_tests(
        dir.path().join("sealed"),
        &endpoint,
        Arc::new(caissepro_local_store::NativeKeyVault),
    )
    .unwrap();
    runtime
        .vault
        .delete(&format!("installation-{}", runtime.namespace))
        .unwrap();
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
#[ignore = "Invoked in separate native processes by the restart qualification test"]
fn native_process_storage_contract() {
    let root = PathBuf::from(std::env::var_os("CAISSEPRO_STORAGE_TEST_ROOT").expect("test root"));
    let endpoint = std::env::var("CAISSEPRO_STORAGE_TEST_SERVER").expect("test server namespace");
    let runtime = Runtime::for_tests(
        root.join("sealed"),
        &endpoint,
        Arc::new(caissepro_local_store::NativeKeyVault),
    )
    .unwrap();
    if std::env::var("CAISSEPRO_STORAGE_TEST_PHASE").unwrap() == "write" {
        let now = wall_now();
        let mut s = session(now);
        s.profile.device_id = runtime.device;
        s.verifier = Some(Verifier::create(PASSWORD).unwrap());
        let d = draft(&s, now);
        s.save_draft(d, now).unwrap();
        runtime.attach(&mut s, now).unwrap();
    } else {
        let mut restored = runtime
            .restore(wall_now())
            .unwrap()
            .expect("encrypted workspace from previous process");
        assert!(restored.locked);
        assert!(restored.token.is_empty());
        assert_eq!(restored.drafts.len(), 1);
        assert!(restored
            .verifier
            .as_ref()
            .unwrap()
            .verify(PASSWORD)
            .unwrap());
        restored.detach_storage("SESSION_REVOKED").unwrap();
    }
}
