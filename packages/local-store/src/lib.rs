//! SQLCipher est compilé avec OpenSSL embarqué. La porte publique reste fermée
//! tant que les tests Windows/macOS et la revue de distribution ne sont pas achevés.
mod key_vault;
mod permissions;
pub use key_vault::{KeyVault, NativeKeyVault};
pub use permissions::protect_directory;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zeroize::Zeroizing;
pub const PLATFORM_STORAGE_VALIDATED: bool = false;
const TTL: i64 = 900_000;
type Result<T> = std::result::Result<T, StoreError>;
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("PLATFORM_ENCRYPTION_NOT_VALIDATED")]
    PlatformNotValidated,
    #[error("KEY_UNAVAILABLE")]
    KeyUnavailable,
    #[error("LOCAL_ACCESS_DENIED")]
    AccessDenied,
    #[error("LOCAL_VERSION_CONFLICT")]
    VersionConflict,
    #[error("LOCAL_DATA_INVALID")]
    InvalidData,
    #[error("LOCAL_STORAGE_UNAVAILABLE")]
    Storage,
}
impl From<rusqlite::Error> for StoreError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}
impl From<std::io::Error> for StoreError {
    fn from(_: std::io::Error) -> Self {
        Self::Storage
    }
}
#[derive(Clone)]
pub struct AuthorizedScope {
    pub company_id: Uuid,
    pub user_id: Uuid,
    pub device_id: Uuid,
    pub authorized_until: i64,
}
impl AuthorizedScope {
    fn key_account(&self) -> String {
        format!("{}.{}.{}", self.company_id, self.user_id, self.device_id)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LocalDraft {
    pub id: Uuid,
    pub kind: String,
    pub currency: String,
    pub amount: String,
    pub description: String,
    pub created_at: i64,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize)]
pub struct DraftRecord {
    pub draft: LocalDraft,
    pub version: i64,
    pub state: String,
    pub server_version: Option<i64>,
}
#[derive(Serialize)]
pub struct CachedData {
    pub payload: serde_json::Value,
    pub version: i64,
    pub synchronized_at: i64,
    pub expires_at: i64,
    pub stale: bool,
}
pub struct EncryptedStore {
    connection: Connection,
    path: PathBuf,
    scope: AuthorizedScope,
    started_at: i64,
    clock: Instant,
}
fn system_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn amount_valid(amount: &str) -> bool {
    let (whole, fraction) = amount.split_once('.').unwrap_or((amount, ""));
    !whole.is_empty()
        && whole.len() <= 16
        && whole.bytes().all(|b| b.is_ascii_digit())
        && (whole == "0" || !whole.starts_with('0'))
        && fraction.len() <= 4
        && fraction.bytes().all(|b| b.is_ascii_digit())
        && (!amount.contains('.') || !fraction.is_empty())
        && amount.bytes().any(|b| (b'1'..=b'9').contains(&b))
}
impl EncryptedStore {
    #[cfg(all(feature = "test-support", debug_assertions))]
    #[doc(hidden)]
    pub fn open_test_checkpoint(
        path: &Path,
        scope: AuthorizedScope,
        vault: &dyn KeyVault,
    ) -> Result<Self> {
        Self::open_with_vault(path, scope, vault)
    }
    pub fn open(path: &Path, scope: AuthorizedScope, vault: &dyn KeyVault) -> Result<Self> {
        if !PLATFORM_STORAGE_VALIDATED {
            return Err(StoreError::PlatformNotValidated);
        }
        Self::open_with_vault(path, scope, vault)
    }
    fn open_with_vault(path: &Path, scope: AuthorizedScope, vault: &dyn KeyVault) -> Result<Self> {
        let account = scope.key_account();
        let existing = path.exists();
        if existing && fs::symlink_metadata(path)?.len() == 0 {
            return Err(StoreError::InvalidData);
        }
        let key = match vault.load(&account)? {
            Some(key) if key.len() == 32 => key,
            Some(_) => return Err(StoreError::KeyUnavailable),
            None if existing => return Err(StoreError::KeyUnavailable),
            None => {
                let mut key = Zeroizing::new(vec![0u8; 32]);
                OsRng
                    .try_fill_bytes(&mut key)
                    .map_err(|_| StoreError::KeyUnavailable)?;
                vault.store(&account, &key)?;
                key
            }
        };
        Self::open_encrypted(path, scope, &key)
    }
    fn open_encrypted(path: &Path, scope: AuthorizedScope, key: &[u8]) -> Result<Self> {
        let now = system_now();
        if key.len() != 32 || scope.authorized_until <= now || scope.authorized_until - now > TTL {
            return Err(StoreError::AccessDenied);
        }
        let probe = Connection::open_in_memory()?;
        let cipher: String = probe.query_row("PRAGMA cipher_version", [], |r| r.get(0))?;
        if cipher.is_empty() {
            return Err(StoreError::Storage);
        }
        if !path.exists() {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(path)?;
        }
        permissions::protect_file(path)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let hex_key = Zeroizing::new(hex::encode(key));
        let statement = Zeroizing::new(format!("PRAGMA key=\"x'{}'\"", hex_key.as_str()));
        connection.execute_batch(statement.as_str())?;
        connection.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })?;
        connection.execute_batch("PRAGMA cipher_memory_security=ON;PRAGMA foreign_keys=ON;PRAGMA temp_store=MEMORY;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let mut store = Self {
            connection,
            path: path.to_owned(),
            scope,
            started_at: now,
            clock: Instant::now(),
        };
        store.migrate()?;
        store.check_access()?;
        Ok(store)
    }
    fn now(&self) -> i64 {
        system_now()
            .max(self.started_at + self.clock.elapsed().as_millis().min(i64::MAX as u128) as i64)
    }
    fn check_access(&self) -> Result<()> {
        if self.now() >= self.scope.authorized_until {
            Err(StoreError::AccessDenied)
        } else {
            Ok(())
        }
    }
    fn migrate(&mut self) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let version: i64 = transaction.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            transaction.execute_batch(include_str!("../migrations/001_local.sql"))?;
            transaction.execute(
                "INSERT INTO local_scope VALUES(1,?1,?2,?3)",
                params![
                    self.scope.company_id.to_string(),
                    self.scope.user_id.to_string(),
                    self.scope.device_id.to_string()
                ],
            )?;
            transaction.pragma_update(None, "user_version", 1)?;
        } else if !(1..=3).contains(&version) {
            return Err(StoreError::InvalidData);
        }
        if version < 2 {
            transaction.execute_batch(include_str!("../migrations/002_multicurrency.sql"))?;
            transaction.pragma_update(None, "user_version", 2)?;
        }
        if version < 3 {
            transaction.execute_batch(include_str!("../migrations/003_workspace.sql"))?;
            transaction.pragma_update(None, "user_version", 3)?;
        }
        let scope: (String, String, String) = transaction.query_row(
            "SELECT company_id,user_id,device_id FROM local_scope WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if scope
            != (
                self.scope.company_id.to_string(),
                self.scope.user_id.to_string(),
                self.scope.device_id.to_string(),
            )
        {
            return Err(StoreError::AccessDenied);
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn save_draft(&mut self, draft: &LocalDraft, expected_version: Option<i64>) -> Result<i64> {
        self.check_access()?;
        let now = self.now();
        if !["receipt", "expense-request"].contains(&draft.kind.as_str())
            || draft.currency.len() != 3
            || draft.currency.bytes().any(|c| !c.is_ascii_uppercase())
            || !amount_valid(&draft.amount)
            || draft.description.trim().is_empty()
            || draft.description.chars().count() > 500
            || draft.created_at > now + 1000
            || draft.expires_at <= now
            || draft.expires_at - draft.created_at > TTL
            || draft.expires_at > self.scope.authorized_until
        {
            return Err(StoreError::InvalidData);
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM drafts WHERE expires_at<=?1", [now])?;
        let previous: Option<i64> = tx
            .query_row(
                "SELECT version FROM drafts WHERE id=?1",
                [draft.id.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        if previous != expected_version {
            return Err(StoreError::VersionConflict);
        }
        let version = previous.unwrap_or(0) + 1;
        if previous.is_some() {
            tx.execute("UPDATE drafts SET currency=?2,amount=?3,description=?4,version=?5,state='local',updated_at=?6,kind=?7,created_at=?8,expires_at=?9 WHERE id=?1",params![draft.id.to_string(),draft.currency,draft.amount,draft.description,version,now,draft.kind,draft.created_at,draft.expires_at])?;
        } else {
            tx.execute(
                "INSERT INTO drafts VALUES(?1,?2,?3,?4,?5,1,'local',?6,?7,?8)",
                params![
                    draft.id.to_string(),
                    draft.kind,
                    draft.currency,
                    draft.amount,
                    draft.description,
                    draft.created_at,
                    draft.expires_at,
                    now
                ],
            )?;
            tx.execute(
                "INSERT INTO sync_metadata(draft_id,idempotency_key) VALUES(?1,?1)",
                [draft.id.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(version)
    }
    pub fn list_drafts(&self) -> Result<Vec<DraftRecord>> {
        self.check_access()?;
        self.connection
            .execute("DELETE FROM drafts WHERE expires_at<=?1", [self.now()])?;
        let mut statement=self.connection.prepare("SELECT d.id,d.kind,d.currency,d.amount,d.description,d.created_at,d.expires_at,d.version,d.state,s.server_version FROM drafts d JOIN sync_metadata s ON s.draft_id=d.id ORDER BY d.created_at,d.id")?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<i64>>(9)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (
                id,
                kind,
                currency,
                amount,
                description,
                created_at,
                expires_at,
                version,
                state,
                server_version,
            ) = row?;
            result.push(DraftRecord {
                draft: LocalDraft {
                    id: Uuid::parse_str(&id).map_err(|_| StoreError::InvalidData)?,
                    kind,
                    currency,
                    amount,
                    description,
                    created_at,
                    expires_at,
                },
                version,
                state,
                server_version,
            });
        }
        Ok(result)
    }
    pub fn record_sync_result(&mut self, id: Uuid, version: i64, code: &str) -> Result<()> {
        self.check_access()?;
        let now = self.now();
        let state = match code {
            "draft-received" => "synced",
            "conflict" => "conflict",
            "validation-failed" => "error",
            "offline" | "transport-error" => "local",
            _ => return Err(StoreError::InvalidData),
        };
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if tx.execute(
            "UPDATE drafts SET state=?3 WHERE id=?1 AND version=?2 AND expires_at>?4",
            params![id.to_string(), version, state, now],
        )? != 1
        {
            return Err(StoreError::VersionConflict);
        }
        tx.execute("UPDATE sync_metadata SET last_attempt_at=?2,last_attempt_version=?3,result_code=?4,server_version=CASE WHEN ?4='draft-received' THEN ?3 ELSE server_version END WHERE draft_id=?1",params![id.to_string(),now,version,code])?;
        tx.commit()?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn cache_authorized(
        &self,
        resource: &str,
        permission: &str,
        payload: &serde_json::Value,
        version: i64,
        synchronized_at: i64,
        expires_at: i64,
        authorized_until: i64,
    ) -> Result<()> {
        self.check_access()?;
        let now = self.now();
        if resource.is_empty()
            || permission.is_empty()
            || version < 1
            || synchronized_at > now + 1000
            || expires_at <= now
            || expires_at - synchronized_at > TTL
            || expires_at <= synchronized_at
            || expires_at > authorized_until
            || authorized_until > self.scope.authorized_until
        {
            return Err(StoreError::AccessDenied);
        }
        let changed=self.connection.execute("INSERT INTO authorized_cache VALUES(?1,?2,?3,?4,1,?5,?6,?7) ON CONFLICT(resource_id) DO UPDATE SET permission=excluded.permission,payload=excluded.payload,version=excluded.version,synchronized_at=excluded.synchronized_at,expires_at=excluded.expires_at,authorized_until=excluded.authorized_until WHERE authorized_cache.version<excluded.version",params![resource,permission,payload.to_string(),version,synchronized_at,expires_at,authorized_until])?;
        if changed != 1 {
            return Err(StoreError::VersionConflict);
        }
        Ok(())
    }
    pub fn read_cache(&self, resource: &str, permission: &str) -> Result<Option<CachedData>> {
        self.check_access()?;
        let now = self.now();
        self.connection.execute(
            "DELETE FROM authorized_cache WHERE expires_at<=?1 OR authorized_until<=?1",
            [now],
        )?;
        let row:Option<(String,i64,i64,i64)>=self.connection.query_row("SELECT payload,version,synchronized_at,expires_at FROM authorized_cache WHERE resource_id=?1 AND permission=?2",params![resource,permission],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        row.map(|(payload, version, synchronized_at, expires_at)| {
            Ok(CachedData {
                payload: serde_json::from_str(&payload).map_err(|_| StoreError::InvalidData)?,
                version,
                synchronized_at,
                expires_at,
                stale: true,
            })
        })
        .transpose()
    }
    pub fn purge(self, vault: &dyn KeyVault) -> Result<()> {
        let account = self.scope.key_account();
        let path = self.path;
        self.connection.close().map_err(|_| StoreError::Storage)?;
        vault.delete(&account)?;
        fs::remove_file(path)?;
        Ok(())
    }

    /// A complete checkpoint is committed atomically, including an in-flight sync payload.
    /// The caller is the native broker, never JavaScript or an asserted client identity.
    pub fn checkpoint(
        &mut self,
        payload: &[u8],
        retained_until: i64,
        expected: Option<i64>,
    ) -> Result<i64> {
        self.check_access()?;
        let now = self.now();
        if payload.len() > 32 * 1024 * 1024
            || retained_until <= now
            || retained_until - now > 7 * 86_400_000
            || serde_json::from_slice::<serde_json::Value>(payload).is_err()
        {
            return Err(StoreError::InvalidData);
        }
        let revision = expected
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(StoreError::InvalidData)?;
        let changed = self.connection.execute(
            "INSERT INTO workspace_checkpoint SELECT 1,?1,?2,?3,?4 WHERE (?5 IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_checkpoint)) OR EXISTS(SELECT 1 FROM workspace_checkpoint WHERE revision=?5) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,retained_until=excluded.retained_until,payload=excluded.payload WHERE workspace_checkpoint.revision=?5",
            params![revision, now, retained_until, std::str::from_utf8(payload).map_err(|_|StoreError::InvalidData)?, expected],
        )?;
        if changed != 1 {
            return Err(StoreError::VersionConflict);
        }
        Ok(revision)
    }
    pub fn read_checkpoint(&self) -> Result<Option<(i64, Zeroizing<Vec<u8>>)>> {
        self.check_access()?;
        let row: Option<(i64, i64, Vec<u8>)> = self.connection.query_row(
            "SELECT revision,retained_until,CAST(payload AS BLOB) FROM workspace_checkpoint WHERE singleton=1",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        Ok(row
            .filter(|(_, until, _)| *until > self.now())
            .map(|(rev, _, bytes)| (rev, Zeroizing::new(bytes))))
    }
    pub fn checkpoint_revision(&self) -> Result<Option<i64>> {
        self.check_access()?;
        Ok(self
            .connection
            .query_row(
                "SELECT revision FROM workspace_checkpoint WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn renew_authorization(&mut self, until: i64) -> Result<()> {
        if until <= self.now() || until - self.now() > TTL {
            return Err(StoreError::AccessDenied);
        }
        self.scope.authorized_until = until;
        Ok(())
    }
}
#[cfg(test)]
mod tests;
