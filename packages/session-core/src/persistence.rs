//! Native-only encrypted checkpoints. No bearer token or plaintext password is serialized.
use crate::{
    model::*,
    state::{millis, Session, Verifier, DRAFT_RETENTION_MS, OFFLINE_MS},
    Error, Result,
};
use caissepro_local_store::{AuthorizedScope, EncryptedStore, KeyVault};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VerifierMaterial {
    pub salt: [u8; 16],
    pub key: [u8; 32],
}
impl Drop for VerifierMaterial {
    fn drop(&mut self) {
        self.salt.zeroize();
        self.key.zeroize();
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    company: Uuid,
    user: Uuid,
    device: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    owner: Owner,
    until: i64,
    saved_at: i64,
    revision: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    format: u32,
    saved_at: i64,
    profile: Profile,
    verifier: Option<VerifierMaterial>,
    failures: u8,
    drafts: HashMap<Uuid, DraftRecord>,
    buffers: HashMap<Uuid, FormBuffer>,
    pending: HashMap<Uuid, PendingSync>,
    balances: Option<serde_json::Value>,
    cash_catalog: Option<serde_json::Value>,
    money_context: Option<serde_json::Value>,
    last_sync_success: Option<String>,
    cache_updated: Option<String>,
}
pub(crate) struct Runtime {
    root: PathBuf,
    namespace: String,
    vault: Arc<dyn KeyVault + Send + Sync>,
    pub device: Uuid,
    #[cfg(test)]
    pub test_sqlcipher: bool,
}
pub(crate) struct Durable {
    store: Option<EncryptedStore>,
    runtime: Arc<Runtime>,
    revision: Option<i64>,
    pub saved_at: i64,
}
fn storage<T>(value: std::result::Result<T, caissepro_local_store::StoreError>) -> Result<T> {
    value.map_err(|_| Error::LocalStorage)
}

impl Runtime {
    #[cfg(test)]
    pub(crate) fn for_tests(
        root: PathBuf,
        server: &str,
        vault: Arc<dyn KeyVault + Send + Sync>,
    ) -> Result<Arc<Self>> {
        let mut runtime = Self::new(root, server, "test", vault)?;
        Arc::get_mut(&mut runtime).unwrap().test_sqlcipher = true;
        Ok(runtime)
    }
    pub(crate) fn new(
        root: PathBuf,
        server: &str,
        deployment: &str,
        vault: Arc<dyn KeyVault + Send + Sync>,
    ) -> Result<Arc<Self>> {
        let namespace = format!("{:x}", Sha256::digest(format!("{server}\0{deployment}")));
        let account = format!("installation-{namespace}");
        let device = match storage(vault.load(&account))? {
            Some(bytes) => Uuid::from_slice(&bytes).map_err(|_| Error::LocalStorage)?,
            None => {
                let id = Uuid::new_v4();
                storage(vault.store(&account, id.as_bytes()))?;
                id
            }
        };
        if root.exists()
            && fs::symlink_metadata(&root)
                .map_err(|_| Error::LocalStorage)?
                .file_type()
                .is_symlink()
        {
            return Err(Error::LocalStorage);
        }
        fs::create_dir_all(&root).map_err(|_| Error::LocalStorage)?;
        storage(caissepro_local_store::protect_directory(&root))?;
        Ok(Arc::new(Self {
            root,
            namespace,
            vault,
            device,
            #[cfg(test)]
            test_sqlcipher: false,
        }))
    }
    fn ticket_account(&self) -> String {
        format!("resume-{}", self.namespace)
    }
    fn scope(&self, owner: &Owner, until: i64) -> Result<AuthorizedScope> {
        if owner.device != self.device {
            return Err(Error::LocalStorage);
        }
        Ok(AuthorizedScope {
            company_id: owner.company,
            user_id: owner.user,
            device_id: owner.device,
            authorized_until: until,
        })
    }
    fn open(&self, owner: &Owner, until: i64) -> Result<EncryptedStore> {
        let path = self.root.join(format!(
            "{}-{}-{}.db",
            self.namespace, owner.company, owner.user
        ));
        let scope = self.scope(owner, until)?;
        #[cfg(test)]
        if self.test_sqlcipher {
            return storage(EncryptedStore::open_test_checkpoint(
                &path,
                scope,
                self.vault.as_ref(),
            ));
        }
        storage(EncryptedStore::open(&path, scope, self.vault.as_ref()))
    }
    pub(crate) fn revoke_ticket(&self) -> Result<()> {
        storage(self.vault.delete(&self.ticket_account()))
    }
    pub(crate) fn attach(self: &Arc<Self>, session: &mut Session, now: i64) -> Result<()> {
        let owner = Owner {
            company: session.profile.company.id,
            user: session.profile.user.id,
            device: self.device,
        };
        let until = session.absolute_until.min(now + OFFLINE_MS);
        let mut store = self.open(&owner, until)?;
        let mut revision = storage(store.checkpoint_revision())?;
        if let Some((_, bytes)) = storage(store.read_checkpoint())? {
            let snapshot: Checkpoint =
                serde_json::from_slice(&bytes).map_err(|_| Error::LocalStorage)?;
            if snapshot.profile.user.id != owner.user
                || snapshot.profile.company.id != owner.company
                || snapshot.profile.device_id != owner.device
            {
                return Err(Error::LocalStorage);
            }
            if snapshot.profile.same_scope(&session.profile) {
                snapshot.apply_workspace(session, now)?;
            } else {
                self.revoke_ticket()?;
                storage(store.purge(self.vault.as_ref()))?;
                store = self.open(&owner, until)?;
                revision = None;
            }
        }
        session.durable = Some(Durable {
            store: Some(store),
            runtime: self.clone(),
            revision,
            saved_at: now,
        });
        session.checkpoint(now)
    }
    pub(crate) fn restore(self: &Arc<Self>, now: i64) -> Result<Option<Session>> {
        let Some(bytes) = storage(self.vault.load(&self.ticket_account()))? else {
            return Ok(None);
        };
        let ticket: Ticket = serde_json::from_slice(&bytes).map_err(|_| Error::LocalStorage)?;
        if ticket.until <= now || ticket.saved_at > now || ticket.until - now > OFFLINE_MS {
            self.revoke_ticket()?;
            return Ok(None);
        }
        let store = self.open(&ticket.owner, ticket.until)?;
        let Some((revision, bytes)) = storage(store.read_checkpoint())? else {
            return Err(Error::LocalStorage);
        };
        let snapshot: Checkpoint =
            serde_json::from_slice(&bytes).map_err(|_| Error::LocalStorage)?;
        if revision != ticket.revision
            || snapshot.saved_at != ticket.saved_at
            || snapshot
                .profile
                .offline_until
                .as_ref()
                .is_none_or(|v| millis(v).ok() != Some(ticket.until))
        {
            return Err(Error::LocalStorage);
        }
        if snapshot.profile.user.id != ticket.owner.user
            || snapshot.profile.company.id != ticket.owner.company
            || snapshot.profile.device_id != self.device
        {
            return Err(Error::LocalStorage);
        }
        let verifier = snapshot.verifier.as_ref().ok_or(Error::LocalStorage)?;
        let material = VerifierMaterial {
            salt: verifier.salt,
            key: verifier.key,
        };
        // Empty token after restart: only an online password login may create another server session.
        let mut session = Session::new_offline(
            snapshot.profile.clone(),
            Some(Verifier::import(material)),
            now,
        )?;
        session.token.clear();
        session.online = false;
        session.locked = true;
        session.failures = snapshot.failures;
        snapshot.apply_workspace(&mut session, now)?;
        session.durable = Some(Durable {
            store: Some(store),
            runtime: self.clone(),
            revision: Some(revision),
            saved_at: ticket.saved_at,
        });
        Ok(Some(session))
    }
}

impl Checkpoint {
    fn apply_workspace(self, session: &mut Session, now: i64) -> Result<()> {
        if self.format != 1
            || self.saved_at > now
            || self.drafts.len() > 200
            || self.buffers.len() > 20
            || self.pending.len() > 200
        {
            return Err(Error::LocalStorage);
        }
        let mut validator = Session::new_offline(session.profile.clone(), None, now)?;
        validator.locked = false;
        validator.online = true;
        validator.money_context = self.money_context.clone();
        for (id, r) in self.drafts {
            if id != r.draft.id
                || r.version == 0
                || !["receipt", "expense-request"].contains(&r.draft.kind.as_str())
                || ![
                    "local",
                    "queued",
                    "syncing",
                    "synced",
                    "confirmed",
                    "submitted",
                    "conflict",
                    "error",
                ]
                .contains(&r.state.as_str())
            {
                return Err(Error::LocalStorage);
            }
            if millis(&r.draft.expires_at)? <= now {
                continue;
            }
            session.scope(r.agency_id, r.cash_register_id)?;
            validator.save_draft(
                SaveDraft {
                    draft: r.draft.clone(),
                    agency_id: r.agency_id,
                    cash_register_id: r.cash_register_id,
                    expected_version: None,
                },
                now,
            )?;
            validator.drafts.insert(id, r.clone());
            session.drafts.insert(id, r);
        }
        for (id, b) in self.buffers {
            if id != b.id || !["receipt", "expense-request", "transfer"].contains(&b.kind.as_str())
            {
                return Err(Error::LocalStorage);
            }
            if millis(&b.expires_at)? <= now {
                continue;
            }
            session.scope(b.agency_id, b.cash_register_id)?;
            validator.save_form_buffer(
                FormBufferInput {
                    id: b.id,
                    kind: b.kind.clone(),
                    agency_id: b.agency_id,
                    cash_register_id: b.cash_register_id,
                    expected_local_version: b.expected_local_version,
                    fields: b.fields.clone(),
                },
                now,
            )?;
            if b.kind == "transfer" {
                if let Some(id) = b.fields.get("destinationCashRegisterId") {
                    if !session
                        .profile
                        .cash_registers
                        .iter()
                        .any(|c| c.id.to_string() == *id)
                    {
                        return Err(Error::Forbidden);
                    }
                }
            }
            session.form_buffers.insert(id, b);
        }
        for (id, p) in self.pending {
            if id != p.record.draft.id {
                return Err(Error::LocalStorage);
            }
            if session.drafts.contains_key(&id) {
                session.pending_sync.insert(id, p);
            }
        }
        for r in session.drafts.values_mut() {
            if r.state == "syncing" {
                r.state = "queued".into();
            }
        }
        if session.permission("ledger:read").is_ok() {
            session.balances = self.balances;
            session.cash_catalog = self.cash_catalog;
        }
        session.money_context = self.money_context;
        session.last_sync_success = self.last_sync_success;
        session.sync_cache_updated = self.cache_updated;
        Ok(())
    }
}
impl Session {
    pub(crate) fn checkpoint(&mut self, now: i64) -> Result<()> {
        if self.durable.is_none() {
            return Ok(());
        }
        let mut profile = self.profile.clone();
        // A server lock may omit offlineUntil; preserve the already granted deadline, never extend it.
        profile.offline_until = if self.offline_until > now {
            Some(crate::state::iso(self.offline_until))
        } else {
            None
        };
        let snapshot = Checkpoint {
            format: 1,
            saved_at: now,
            profile,
            verifier: self.verifier.as_ref().map(Verifier::export),
            failures: self.failures,
            drafts: self.drafts.clone(),
            buffers: self.form_buffers.clone(),
            pending: self.pending_sync.clone(),
            balances: self.balances.clone(),
            cash_catalog: self.cash_catalog.clone(),
            money_context: self.money_context.clone(),
            last_sync_success: self.last_sync_success.clone(),
            cache_updated: self.sync_cache_updated.clone(),
        };
        let payload =
            Zeroizing::new(serde_json::to_vec(&snapshot).map_err(|_| Error::LocalStorage)?);
        let can_resume = self.offline_until > now
            && self.verifier.is_some()
            && self.permission("offline:access").is_ok()
            && !self.profile.user.must_change_password;
        let durable = self.durable.as_mut().ok_or(Error::LocalStorage)?;
        let store = durable.store.as_mut().ok_or(Error::LocalStorage)?;
        storage(store.renew_authorization(self.absolute_until.min(now + OFFLINE_MS)))?;
        let revision =
            storage(store.checkpoint(&payload, now + DRAFT_RETENTION_MS, durable.revision))?;
        durable.revision = Some(revision);
        durable.saved_at = now;
        if can_resume {
            let ticket = Zeroizing::new(
                serde_json::to_vec(&Ticket {
                    owner: Owner {
                        company: self.profile.company.id,
                        user: self.profile.user.id,
                        device: self.profile.device_id,
                    },
                    until: self.offline_until,
                    saved_at: now,
                    revision,
                })
                .map_err(|_| Error::LocalStorage)?,
            );
            storage(
                durable
                    .runtime
                    .vault
                    .store(&durable.runtime.ticket_account(), &ticket),
            )?;
        } else {
            durable.runtime.revoke_ticket()?;
        }
        Ok(())
    }
    pub(crate) fn detach_storage(&mut self, reason: &str) -> Result<()> {
        if self.durable.is_none() {
            return Ok(());
        }
        if let Some(durable) = self.durable.as_ref() {
            let current = storage(
                durable
                    .store
                    .as_ref()
                    .ok_or(Error::LocalStorage)?
                    .checkpoint_revision(),
            )?;
            if current != durable.revision {
                self.durable = None;
                return Err(Error::LocalStorage);
            }
        }
        // Two independent barriers: invalidate the encrypted lease/revision first,
        // then remove the native ticket. A failed key-vault deletion cannot revive it.
        self.offline_until = 0;
        let now = crate::state::wall_now();
        let write_result = if now < self.absolute_until {
            self.checkpoint(now)
        } else {
            Ok(())
        };
        let Some(mut durable) = self.durable.take() else {
            return Err(Error::LocalStorage);
        };
        let ticket_result = durable.runtime.revoke_ticket();
        let mut purge_result = Ok(());
        if [
            "SESSION_REVOKED",
            "SERVER_IDENTITY_INVALID",
            "SERVER_RESPONSE_INVALID",
            "PASSWORD_CHANGED",
            "SCOPE_CHANGED",
        ]
        .contains(&reason)
        {
            if let Some(store) = durable.store.take() {
                purge_result = storage(store.purge(durable.runtime.vault.as_ref()));
            }
        }
        write_result.and(ticket_result).and(purge_result)
    }
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
pub(crate) mod tests;
