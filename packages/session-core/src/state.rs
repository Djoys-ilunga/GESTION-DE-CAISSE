use crate::{model::*, Error, Result};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use std::{
    collections::HashMap,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;
pub const OFFLINE_MS: i64 = 900_000;
const AUTO_LOCK_MS: i64 = 300_000;
pub fn wall_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
pub fn millis(value: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.timestamp_millis())
        .map_err(|_| Error::InvalidResponse)
}
pub fn iso(now: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub struct Clock {
    start: i64,
    instant: Instant,
}
impl Default for Clock {
    fn default() -> Self {
        Self {
            start: wall_now(),
            instant: Instant::now(),
        }
    }
}
impl Clock {
    pub fn now(&self) -> i64 {
        wall_now().max(self.start + self.instant.elapsed().as_millis().min(i64::MAX as u128) as i64)
    }
}
pub struct Verifier {
    salt: Zeroizing<[u8; 16]>,
    key: Zeroizing<[u8; 32]>,
}
impl Verifier {
    pub fn create(password: &str) -> Result<Self> {
        let mut salt = Zeroizing::new([0; 16]);
        OsRng
            .try_fill_bytes(salt.as_mut())
            .map_err(|_| Error::Unavailable)?;
        let mut key = Zeroizing::new([0; 32]);
        scrypt::scrypt(
            password.as_bytes(),
            salt.as_ref(),
            &scrypt::Params::new(17, 8, 1, 32).map_err(|_| Error::Unavailable)?,
            key.as_mut(),
        )
        .map_err(|_| Error::Unavailable)?;
        Ok(Self { salt, key })
    }
    pub fn verify(&self, password: &str) -> Result<bool> {
        let mut key = Zeroizing::new([0; 32]);
        scrypt::scrypt(
            password.as_bytes(),
            self.salt.as_ref(),
            &scrypt::Params::new(17, 8, 1, 32).map_err(|_| Error::Unavailable)?,
            key.as_mut(),
        )
        .map_err(|_| Error::Unavailable)?;
        Ok(bool::from(key.as_ref().ct_eq(self.key.as_ref())))
    }
}
pub struct Session {
    pub token: Zeroizing<String>,
    pub profile: Profile,
    pub verifier: Option<Verifier>,
    pub offline_until: i64,
    pub absolute_until: i64,
    pub last_activity: i64,
    pub last_activity_sent: i64,
    pub locked: bool,
    pub online: bool,
    pub failures: u8,
    pub drafts: HashMap<uuid::Uuid, DraftRecord>,
    pub balances: Option<serde_json::Value>,
    pub revalidating: bool,
}
impl Session {
    pub fn validate_profile(profile: &Profile, now: i64) -> Result<(i64, i64)> {
        let validated = millis(&profile.validated_at)?;
        let absolute = millis(&profile.expires_at)?.min(millis(&profile.idle_expires_at)?);
        if validated > now + 30_000
            || absolute <= now
            || absolute - validated > 8 * 60 * 60 * 1000
            || profile.authorization_version == 0
        {
            return Err(Error::InvalidResponse);
        }
        let offline = match profile.offline_until.as_deref() {
            Some(value) => {
                let end = millis(value)?;
                if end > absolute
                    || end - validated > OFFLINE_MS
                    || !profile.permissions.iter().any(|p| p == "offline:access")
                    || profile.user.must_change_password
                {
                    return Err(Error::InvalidResponse);
                }
                end
            }
            None => 0,
        };
        Ok((offline, absolute))
    }
    pub fn new(
        token: Zeroizing<String>,
        profile: Profile,
        verifier: Option<Verifier>,
        now: i64,
    ) -> Result<Self> {
        let (offline_until, absolute_until) = Self::validate_profile(&profile, now)?;
        if token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Error::InvalidResponse);
        }
        Ok(Self {
            token,
            locked: profile.locked,
            profile,
            verifier,
            offline_until,
            absolute_until,
            last_activity: now,
            last_activity_sent: now,
            online: true,
            failures: 0,
            drafts: HashMap::new(),
            balances: None,
            revalidating: false,
        })
    }
    pub fn permission(&self, p: &str) -> Result<()> {
        if self.profile.permissions.iter().any(|v| v == p) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
    pub fn guard(&self, now: i64) -> Result<()> {
        if now >= self.absolute_until || (!self.online && now >= self.offline_until) {
            return Err(Error::Expired);
        }
        if self.locked || self.revalidating {
            return Err(Error::Locked);
        }
        if now - self.last_activity >= AUTO_LOCK_MS {
            return Err(Error::Locked);
        }
        if self.profile.user.must_change_password {
            return Err(Error::PasswordChangeRequired);
        }
        Ok(())
    }
    pub fn scope(&self, agency: uuid::Uuid, cash: Option<uuid::Uuid>) -> Result<()> {
        if !self.profile.agencies.iter().any(|a| a.id == agency) {
            return Err(Error::Forbidden);
        }
        if let Some(id) = cash {
            if !self
                .profile
                .cash_registers
                .iter()
                .any(|r| r.id == id && r.agency_id == agency)
            {
                return Err(Error::Forbidden);
            }
        }
        Ok(())
    }
    pub fn save_draft(&mut self, input: SaveDraft, now: i64) -> Result<DraftRecord> {
        self.guard(now)?;
        self.permission("draft:write_own")?;
        self.scope(input.agency_id, input.cash_register_id)?;
        let draft = input.draft;
        let created = millis(&draft.created_at)?;
        let expires = millis(&draft.expires_at)?;
        let valid_amount = draft.amount.split_once('.').is_some_and(|(a, b)| {
            !a.is_empty()
                && a.len() <= 16
                && a.bytes().all(|c| c.is_ascii_digit())
                && (a == "0" || !a.starts_with('0'))
                && b.len() == 2
                && b.bytes().all(|c| c.is_ascii_digit())
                && draft.amount != "0.00"
        });
        if !valid_amount
            || !["CDF", "USD"].contains(&draft.currency.as_str())
            || !["receipt", "expense-request"].contains(&draft.kind.as_str())
            || draft.description.trim().is_empty()
            || draft.description.chars().count() > 500
            || created > now + 1000
            || expires <= now
            || expires <= created
            || expires - created > OFFLINE_MS
            || (draft.kind == "receipt" && input.cash_register_id.is_none())
        {
            return Err(Error::InvalidInput);
        }
        self.drafts
            .retain(|_, r| millis(&r.draft.expires_at).is_ok_and(|expiry| expiry > now));
        if let Some(old) = self.drafts.get(&draft.id) {
            if input.expected_version != Some(old.version)
                || old.agency_id != input.agency_id
                || old.cash_register_id != input.cash_register_id
                || old.draft.kind != draft.kind
                || old.draft.created_at != draft.created_at
                || old.draft.expires_at != draft.expires_at
            {
                return Err(Error::Conflict);
            }
        } else if input.expected_version.is_some() {
            return Err(Error::Conflict);
        }
        let old = self.drafts.get(&draft.id);
        let record = DraftRecord {
            version: old.map_or(1, |v| v.version + 1),
            server_version: old.and_then(|v| v.server_version),
            draft,
            agency_id: input.agency_id,
            cash_register_id: input.cash_register_id,
            state: "local".into(),
            result: None,
            updated_at: iso(now),
        };
        self.drafts.insert(record.draft.id, record.clone());
        Ok(record)
    }
    pub fn list_drafts(&mut self, now: i64) -> Result<Vec<DraftRecord>> {
        self.guard(now)?;
        self.permission("draft:read_own")?;
        self.drafts
            .retain(|_, r| millis(&r.draft.expires_at).is_ok_and(|e| e > now));
        let mut drafts = self.drafts.values().cloned().collect::<Vec<_>>();
        drafts.sort_by_key(|r| r.draft.id);
        Ok(drafts)
    }
}
#[derive(Default)]
pub struct State {
    pub generation: u64,
    pub session: Option<Session>,
    pub reason: Option<String>,
}
impl State {
    pub fn clear(&mut self, reason: &str) {
        self.session = None;
        self.generation += 1;
        self.reason = Some(reason.into());
    }
    pub fn view(&mut self, now: i64) -> SessionView {
        let expired = self
            .session
            .as_ref()
            .is_some_and(|s| now >= s.absolute_until || (!s.online && now >= s.offline_until));
        if expired {
            self.clear("SESSION_EXPIRED")
        }
        if let Some(s) = self.session.as_mut() {
            if now - s.last_activity >= AUTO_LOCK_MS {
                s.locked = true;
            }
        }
        let Some(s) = self.session.as_ref() else {
            return SessionView {
                state: "anonymous".into(),
                profile: None,
                display_name: None,
                offline_until: None,
                reason: self.reason.clone(),
                generation: self.generation,
            };
        };
        SessionView {
            state: if s.revalidating {
                "revalidating"
            } else if s.locked {
                "locked"
            } else if s.online {
                "online"
            } else {
                "offline"
            }
            .into(),
            profile: if s.locked || s.revalidating {
                None
            } else {
                Some(s.profile.clone())
            },
            display_name: Some(s.profile.user.display_name.clone()),
            offline_until: if s.offline_until > now {
                Some(iso(s.offline_until))
            } else {
                None
            },
            reason: self.reason.clone(),
            generation: self.generation,
        }
    }
}
