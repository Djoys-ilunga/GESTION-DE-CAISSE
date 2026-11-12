use super::*;
use std::{
    cell::RefCell,
    sync::{Arc, Barrier},
};
struct Vault {
    key: RefCell<Option<Vec<u8>>>,
}
impl KeyVault for Vault {
    fn load(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Ok(self.key.borrow().clone().map(Zeroizing::new))
    }
    fn store(&self, _: &str, key: &[u8]) -> Result<()> {
        *self.key.borrow_mut() = Some(key.to_vec());
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<()> {
        *self.key.borrow_mut() = None;
        Ok(())
    }
}
fn scope() -> AuthorizedScope {
    AuthorizedScope {
        company_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        device_id: Uuid::new_v4(),
        authorized_until: system_now() + TTL - 1000,
    }
}
fn key() -> Zeroizing<Vec<u8>> {
    let mut key = Zeroizing::new(vec![0; 32]);
    OsRng.fill_bytes(&mut key);
    key
}
fn draft() -> LocalDraft {
    let now = system_now();
    LocalDraft {
        id: Uuid::new_v4(),
        kind: "receipt".into(),
        currency: "USD".into(),
        amount: "9007199254740993.01".into(),
        description: "INFORMATION_PERSONNELLE_TEST".into(),
        created_at: now,
        expires_at: now + 10000,
    }
}
#[test]
fn public_gate_precedes_any_file_or_key_creation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.db");
    let vault = Vault {
        key: RefCell::new(None),
    };
    assert!(matches!(
        EncryptedStore::open(&path, scope(), &vault),
        Err(StoreError::PlatformNotValidated)
    ));
    assert!(!path.exists());
    assert!(vault.key.borrow().is_none());
}
#[test]
fn checkpoint_is_atomic_versioned_encrypted_and_preserves_payload_on_rejected_write() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("checkpoint.db");
    let scope = scope();
    let key = key();
    let mut s = EncryptedStore::open_encrypted(&file, scope.clone(), &key).unwrap();
    let now = system_now();
    let payload=br#"{"format":1,"drafts":[{"id":"stable-id","amount":"9007199254740993.01","currency":"JPY","author":"OWNER_SECRET_TEST"}]}"#;
    assert!(matches!(
        s.checkpoint(payload, now + 10000, Some(4)),
        Err(StoreError::VersionConflict)
    ));
    assert_eq!(s.checkpoint(payload, now + 10000, None).unwrap(), 1);
    assert!(matches!(
        s.checkpoint(br#"{"bad":true}"#, now + 10000, None),
        Err(StoreError::VersionConflict)
    ));
    assert!(s.checkpoint(b"broken-json", now + 10000, Some(1)).is_err());
    drop(s);
    let s = EncryptedStore::open_encrypted(&file, scope, &key).unwrap();
    let (revision, data) = s.read_checkpoint().unwrap().unwrap();
    assert_eq!(revision, 1);
    assert_eq!(data.as_slice(), payload);
    let bytes = fs::read(file).unwrap();
    assert!(!bytes.windows(17).any(|b| b == b"OWNER_SECRET_TEST"));
}
#[test]
fn existing_truncated_database_is_not_silently_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("truncated.db");
    fs::write(&file, []).unwrap();
    let vault = Vault {
        key: RefCell::new(Some(key().to_vec())),
    };
    assert!(matches!(
        EncryptedStore::open_with_vault(&file, scope(), &vault),
        Err(StoreError::InvalidData)
    ));
    assert_eq!(fs::metadata(file).unwrap().len(), 0);
}
#[test]
fn sqlcipher_encrypts_reopens_and_rejects_wrong_or_missing_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.db");
    let scope = scope();
    let key = key();
    let mut store = EncryptedStore::open_encrypted(&path, scope.clone(), &key).unwrap();
    let provider: String = store
        .connection
        .query_row("PRAGMA cipher_provider", [], |r| r.get(0))
        .unwrap();
    assert!(provider.to_lowercase().contains("openssl"));
    store.save_draft(&draft(), None).unwrap();
    drop(store);
    let bytes = fs::read(&path).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3"));
    assert!(!bytes
        .windows(28)
        .any(|w| w == b"INFORMATION_PERSONNELLE_TEST"));
    assert!(!bytes.windows(32).any(|w| w == key.as_slice()));
    assert!(EncryptedStore::open_encrypted(&path, scope.clone(), &self::key()).is_err());
    let plain = Connection::open(&path).unwrap();
    assert!(plain
        .query_row("SELECT count(*) FROM sqlite_master", [], |r| r
            .get::<_, i64>(0))
        .is_err());
    drop(plain);
    let reopened = EncryptedStore::open_encrypted(&path, scope, &key).unwrap();
    assert_eq!(reopened.list_drafts().unwrap().len(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[test]
fn migrations_are_repeatable_and_scope_is_bound() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.db");
    let key = key();
    let scope = scope();
    let mut s = EncryptedStore::open_encrypted(&path, scope.clone(), &key).unwrap();
    s.migrate().unwrap();
    drop(s);
    let mut other = scope;
    other.user_id = Uuid::new_v4();
    assert!(matches!(
        EncryptedStore::open_encrypted(&path, other, &key),
        Err(StoreError::AccessDenied)
    ));
}
#[test]
fn amounts_ids_and_optimistic_versions_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let mut s =
        EncryptedStore::open_encrypted(&dir.path().join("local.db"), scope(), &key()).unwrap();
    let mut d = draft();
    assert_eq!(s.save_draft(&d, None).unwrap(), 1);
    assert!(matches!(
        s.save_draft(&d, None),
        Err(StoreError::VersionConflict)
    ));
    d.amount = "9007199254740993.02".into();
    assert_eq!(s.save_draft(&d, Some(1)).unwrap(), 2);
    let r = s.list_drafts().unwrap().remove(0);
    assert_eq!(r.draft.id, d.id);
    assert_eq!(r.draft.amount, d.amount);
    d.amount = "1e3".into();
    assert!(matches!(
        s.save_draft(&d, Some(2)),
        Err(StoreError::InvalidData)
    ));
}
#[test]
fn concurrent_connections_cannot_overwrite_the_same_revision() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.db");
    let scope = scope();
    let key = key();
    let d = draft();
    let mut first = EncryptedStore::open_encrypted(&path, scope.clone(), &key).unwrap();
    first.save_draft(&d, None).unwrap();
    let second = EncryptedStore::open_encrypted(&path, scope, &key).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles = [first, second]
        .into_iter()
        .enumerate()
        .map(|(i, mut store)| {
            let barrier = barrier.clone();
            let mut draft = d.clone();
            std::thread::spawn(move || {
                draft.amount = format!("{}.00", i + 1);
                barrier.wait();
                store.save_draft(&draft, Some(1))
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(StoreError::VersionConflict)))
            .count(),
        1
    );
}
#[test]
fn authorized_cache_expires_and_requires_explicit_permission() {
    let dir = tempfile::tempdir().unwrap();
    let mut scope = scope();
    scope.authorized_until = system_now() + 1000;
    let s = EncryptedStore::open_encrypted(&dir.path().join("local.db"), scope, &key()).unwrap();
    let now = system_now();
    s.cache_authorized(
        "balance",
        "ledger:read",
        &serde_json::json!({"amount":"12.34"}),
        1,
        now,
        now + 500,
        now + 900,
    )
    .unwrap();
    assert!(s.read_cache("balance", "other").unwrap().is_none());
    assert!(
        s.read_cache("balance", "ledger:read")
            .unwrap()
            .unwrap()
            .stale
    );
    assert!(s
        .cache_authorized(
            "balance",
            "ledger:read",
            &serde_json::json!({}),
            1,
            now,
            now + 500,
            now + 900
        )
        .is_err());
    std::thread::sleep(Duration::from_millis(510));
    assert!(s.read_cache("balance", "ledger:read").unwrap().is_none());
}
#[test]
fn sync_metadata_never_creates_financial_operations() {
    let dir = tempfile::tempdir().unwrap();
    let mut s =
        EncryptedStore::open_encrypted(&dir.path().join("local.db"), scope(), &key()).unwrap();
    let d = draft();
    s.save_draft(&d, None).unwrap();
    assert!(s.record_sync_result(d.id, 1, "payment-confirmed").is_err());
    s.record_sync_result(d.id, 1, "draft-received").unwrap();
    let r = s.list_drafts().unwrap().remove(0);
    assert_eq!(r.state, "synced");
    assert_eq!(r.server_version, Some(1));
    assert_eq!(s.connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('FinancialOperation','LedgerEntry','balances')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn corruption_is_detected_before_access() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.db");
    let scope = scope();
    let key = key();
    drop(EncryptedStore::open_encrypted(&path, scope.clone(), &key).unwrap());
    let mut bytes = fs::read(&path).unwrap();
    bytes[150] ^= 0x55;
    fs::write(&path, bytes).unwrap();
    assert!(EncryptedStore::open_encrypted(&path, scope, &key).is_err());
}
#[test]
fn purge_deletes_file_and_vault_key_without_replacing_a_missing_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.db");
    let scope = scope();
    let vault = Vault {
        key: RefCell::new(None),
    };
    let s = EncryptedStore::open_with_vault(&path, scope.clone(), &vault).unwrap();
    assert_eq!(vault.key.borrow().as_ref().unwrap().len(), 32);
    s.purge(&vault).unwrap();
    assert!(!path.exists());
    assert!(vault.key.borrow().is_none());
    fs::write(&path, b"existing").unwrap();
    assert!(matches!(
        EncryptedStore::open_with_vault(&path, scope, &vault),
        Err(StoreError::KeyUnavailable)
    ));
    assert_eq!(fs::read(path).unwrap(), b"existing");
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
fn native_key_vault_roundtrip() {
    let vault = NativeKeyVault;
    let account = format!("qualification.{}", Uuid::new_v4());
    let key = key();
    vault.store(&account, &key).unwrap();
    assert_eq!(
        vault.load(&account).unwrap().unwrap().as_slice(),
        key.as_slice()
    );
    vault.delete(&account).unwrap();
    assert!(vault.load(&account).unwrap().is_none());
}

#[test]
fn legacy_encrypted_drafts_and_acknowledgements_survive_currency_schema_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.db");
    let encryption_key = key();
    let authorized = scope();
    let d = draft();
    {
        let conn = Connection::open(&path).unwrap();
        let hex_key = Zeroizing::new(hex::encode(encryption_key.as_slice()));
        conn.execute_batch(&format!(
            "PRAGMA key=\"x'{}'\";PRAGMA foreign_keys=ON;",
            hex_key.as_str()
        ))
        .unwrap();
        conn.execute_batch(include_str!("../migrations/001_local.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO local_scope VALUES(1,?1,?2,?3)",
            params![
                authorized.company_id.to_string(),
                authorized.user_id.to_string(),
                authorized.device_id.to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO drafts VALUES(?1,'receipt','USD',?2,?3,3,'synced',?4,?5,?4)",
            params![
                d.id.to_string(),
                d.amount,
                d.description,
                d.created_at,
                d.expires_at
            ],
        )
        .unwrap();
        conn.execute("INSERT INTO sync_metadata(draft_id,idempotency_key,server_version,result_code) VALUES(?1,?1,7,'draft-received')",params![d.id.to_string()]).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
    }
    let mut store = EncryptedStore::open_encrypted(&path, authorized, &encryption_key).unwrap();
    let saved: (String,i64,i64)=store.connection.query_row("SELECT d.amount,d.version,s.server_version FROM drafts d JOIN sync_metadata s ON s.draft_id=d.id WHERE d.id=?1",params![d.id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(saved, (d.amount.clone(), 3, 7));
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    let mut japanese = d.clone();
    japanese.id = Uuid::new_v4();
    japanese.currency = "JPY".into();
    japanese.amount = "123".into();
    store.save_draft(&japanese, None).unwrap();
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT amount FROM drafts WHERE id=?1",
                params![japanese.id.to_string()],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "123"
    );
    store.migrate().unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn windows_database_and_directory_have_protected_owner_system_admin_acl() {
    let dir = tempfile::tempdir().unwrap();
    protect_directory(dir.path()).unwrap();
    let file = dir.path().join("private.db");
    let store = EncryptedStore::open_encrypted(&file, scope(), &key()).unwrap();
    for path in [dir.path(), file.as_path()] {
        let status=std::process::Command::new("powershell.exe").args(["-NoLogo","-NoProfile","-NonInteractive","-Command",r#"$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:CAISSEPRO_ACL_TEST_PATH; if(!$acl.AreAccessRulesProtected -or $acl.Access.Count -lt 3){exit 1}; $allowed=@('S-1-3-4','S-1-5-18','S-1-5-32-544',[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value); foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed){exit 1}}; exit 0"#])
            .env("CAISSEPRO_ACL_TEST_PATH",path).status().unwrap();
        assert!(status.success(), "Private Windows ACL required");
    }
    drop(store);
}
