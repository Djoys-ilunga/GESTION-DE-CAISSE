use crate::{
    model::*,
    state::{iso, millis, Session},
    Error, Result,
};
use uuid::Uuid;

impl Session {
    pub(crate) fn sync_note(&mut self, id: Uuid, version: u32, code: &str, now: i64) {
        self.sync_events.push(SyncNote {
            draft_id: id,
            version,
            code: code.into(),
            at: iso(now),
        });
        if self.sync_events.len() > 100 {
            self.sync_events.remove(0);
        }
    }
    pub(crate) fn prepare_sync(&mut self, id: Uuid, now: i64) -> Result<Option<PendingSync>> {
        self.guard(now)?;
        self.permission("draft:write_own")?;
        let Some(record) = self.drafts.get_mut(&id) else {
            return Ok(None);
        };
        if ["synced", "confirmed", "submitted", "conflict", "error"]
            .contains(&record.state.as_str())
        {
            return Ok(None);
        }
        if record.attempts >= 5 {
            record.state = "error".into();
            return Ok(None);
        }
        if record
            .next_attempt_at
            .as_ref()
            .is_some_and(|v| millis(v).is_ok_and(|t| t > now))
        {
            return Ok(None);
        }
        if millis(&record.draft.expires_at)? <= now {
            return Ok(None);
        }
        let pending = self
            .pending_sync
            .entry(id)
            .or_insert_with(|| PendingSync {
                record: record.clone(),
            })
            .clone();
        record.state = "syncing".into();
        record.attempts += 1;
        record.last_attempt_at = Some(iso(now));
        record.next_attempt_at = None;
        self.sync_note(id, pending.record.version, "started", now);
        Ok(Some(pending))
    }
    pub(crate) fn finish_sync(
        &mut self,
        pending: &PendingSync,
        response: SyncResult,
        now: i64,
    ) -> Result<()> {
        let id = pending.record.draft.id;
        let Some(current) = self.drafts.get_mut(&id) else {
            self.pending_sync.remove(&id);
            return Ok(());
        };
        let valid = match response.outcome.as_str() {
            "accepted-as-draft" => {
                response.code == "draft-received"
                    && matches!(
                        response.source_state.as_deref(),
                        Some("draft" | "confirmed" | "submitted")
                    )
                    && (response.source_state.as_deref() != Some("confirmed")
                        || response.receipt_id.is_some())
                    && (response.source_state.as_deref() != Some("submitted")
                        || response.expense_request_id.is_some())
            }
            "conflict" => response.code == "conflict",
            "rejected" => response.code == "validation-failed",
            "deferred" => ["transport-error", "rate-limited"].contains(&response.code.as_str()),
            _ => false,
        };
        if !valid {
            return Err(Error::InvalidResponse);
        }
        if response.draft_id != id {
            return Err(Error::InvalidResponse);
        }
        if response.outcome == "accepted-as-draft" {
            if response.server_id.is_none()
                || response.server_version != Some(pending.record.version)
                || response
                    .synchronized_at
                    .as_ref()
                    .is_none_or(|v| millis(v).is_err())
            {
                return Err(Error::InvalidResponse);
            }
            current.server_id = response.server_id;
            current.server_version = response.server_version;
            current.synchronized_at = response.synchronized_at.clone();
            current.next_attempt_at = None;
            current.attempts = 0;
            current.state = if current.version == pending.record.version {
                "synced"
            } else {
                "queued"
            }
            .into();
            if response.source_state.as_deref() == Some("confirmed") {
                current.confirmed_receipt_id = response.receipt_id;
                current.state = if current.version == pending.record.version {
                    "confirmed"
                } else {
                    "conflict"
                }
                .into();
            } else if response.source_state.as_deref() == Some("submitted") {
                current.submitted_expense_id = response.expense_request_id;
                current.state = if current.version == pending.record.version {
                    "submitted"
                } else {
                    "conflict"
                }
                .into();
            }
            self.last_sync_success = Some(iso(now));
            self.pending_sync.remove(&id);
        } else if response.outcome == "deferred" {
            current.state = if current.attempts >= 5 {
                "error"
            } else {
                "queued"
            }
            .into();
            let delay = [5000, 15000, 60000, 180000, 300000]
                [current.attempts.saturating_sub(1).min(4) as usize];
            current.next_attempt_at = Some(iso(now
                + if response.code == "rate-limited" {
                    delay.max(60000)
                } else {
                    delay
                }));
        } else {
            current.state = if response.outcome == "conflict" {
                "conflict"
            } else {
                "error"
            }
            .into();
            self.pending_sync.remove(&id);
        }
        current.result = Some(response.clone());
        self.sync_note(id, pending.record.version, &response.code, now);
        Ok(())
    }
}

impl Session {
    pub(crate) fn list_form_buffers(&mut self, now: i64) -> Result<Vec<FormBuffer>> {
        self.guard(now)?;
        self.permission("draft:read_own")?;
        self.form_buffers
            .retain(|_, b| millis(&b.expires_at).is_ok_and(|end| end > now));
        self.pending_transfers
            .retain(|id, _| self.form_buffers.contains_key(id));
        let mut values = self
            .form_buffers
            .values()
            .cloned()
            .map(|mut b| {
                if let Some(p) = self.pending_transfers.get(&b.id) {
                    b.transmission_state = Some(
                        if p.server_id.is_some() {
                            "received"
                        } else {
                            "uncertain"
                        }
                        .into(),
                    );
                    b.transmitted_transfer_id = p.server_id;
                    b.transmission_changed = Some(
                        b.fields != p.buffer.fields
                            || b.agency_id != p.buffer.agency_id
                            || b.cash_register_id != p.buffer.cash_register_id,
                    );
                }
                b
            })
            .collect::<Vec<_>>();
        values.sort_by_key(|b| b.id);
        Ok(values)
    }
    pub(crate) fn save_form_buffer(
        &mut self,
        input: FormBufferInput,
        now: i64,
    ) -> Result<FormBuffer> {
        self.guard(now)?;
        self.permission("draft:write_own")?;
        self.scope(input.agency_id, input.cash_register_id)?;
        if self
            .form_buffers
            .get(&input.id)
            .is_some_and(|b| b.kind != input.kind)
        {
            return Err(Error::Conflict);
        }
        self.form_buffers
            .retain(|_, b| millis(&b.expires_at).is_ok_and(|end| end > now));
        if !["receipt", "expense-request", "transfer"].contains(&input.kind.as_str())
            || input.fields.len() > 14
            || input.fields.iter().any(|(key, value)| {
                let max = match key.as_str() {
                    "amount" => 21,
                    "currency" | "destinationCurrency" => 3,
                    "destinationCashRegisterId" => 36,
                    "rate" => 25,
                    "rateSource" => 100,
                    "rateQuoteId" => 36,
                    "rateMode" => 6,
                    "rateJustification" => 500,
                    "rateEffectiveAt" => 35,
                    "description" => 500,
                    "provenance" | "category" | "reference" | "beneficiary" => 160,
                    _ => 0,
                };
                max == 0 || value.chars().count() > max
            })
            || (!self.form_buffers.contains_key(&input.id) && self.form_buffers.len() >= 20)
        {
            return Err(Error::InvalidInput);
        }
        if let Some(record) = self.drafts.get(&input.id) {
            if input.expected_local_version != Some(record.version)
                || record.draft.kind != input.kind
                || record.agency_id != input.agency_id
                || record.cash_register_id != input.cash_register_id
                || record.confirmed_receipt_id.is_some()
                || record.submitted_expense_id.is_some()
                || ["confirmed", "submitted"].contains(&record.state.as_str())
            {
                return Err(Error::Conflict);
            }
        } else if input.expected_local_version.is_some() {
            return Err(Error::Conflict);
        }
        if input.kind == "transfer" {
            if let Some(destination) = input.fields.get("destinationCashRegisterId") {
                let id = uuid::Uuid::parse_str(destination).map_err(|_| Error::InvalidInput)?;
                let register = self
                    .profile
                    .cash_registers
                    .iter()
                    .find(|r| r.id == id)
                    .ok_or(Error::Forbidden)?;
                self.scope(register.agency_id, Some(id))?;
            }
        }
        let source_expiry = self
            .drafts
            .get(&input.id)
            .map(|r| millis(&r.draft.expires_at))
            .transpose()?
            .unwrap_or(i64::MAX);
        let old = self.form_buffers.get(&input.id);
        let buffer = FormBuffer {
            transmission_state: None,
            transmitted_transfer_id: None,
            transmission_changed: None,
            id: input.id,
            kind: input.kind,
            agency_id: input.agency_id,
            cash_register_id: input.cash_register_id,
            expected_local_version: input.expected_local_version,
            fields: input.fields,
            created_at: old
                .map(|b| b.created_at.clone())
                .unwrap_or_else(|| iso(now)),
            updated_at: iso(now),
            expires_at: iso(old
                .map(|b| millis(&b.expires_at))
                .transpose()?
                .unwrap_or(now + crate::state::DRAFT_RETENTION_MS)
                .min(source_expiry)),
        };
        self.form_buffers.insert(buffer.id, buffer.clone());
        Ok(buffer)
    }
}
