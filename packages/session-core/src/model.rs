use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct User {
    pub id: Uuid,
    pub display_name: String,
    pub email: String,
    pub must_change_password: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Company {
    pub id: Uuid,
    pub code: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Agency {
    pub id: Uuid,
    pub code: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CashRegister {
    pub id: Uuid,
    pub agency_id: Uuid,
    pub code: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub session_id: Uuid,
    pub device_id: Uuid,
    pub user: User,
    pub company: Company,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub agencies: Vec<Agency>,
    pub cash_registers: Vec<CashRegister>,
    pub expires_at: String,
    pub idle_expires_at: String,
    pub offline_until: Option<String>,
    pub validated_at: String,
    pub locked: bool,
    pub authorization_version: u32,
}
impl Profile {
    pub(crate) fn same_scope(&self, other: &Self) -> bool {
        use std::collections::BTreeSet;
        self.authorization_version == other.authorization_version
            && self.roles.iter().collect::<BTreeSet<_>>()
                == other.roles.iter().collect::<BTreeSet<_>>()
            && self.permissions.iter().collect::<BTreeSet<_>>()
                == other.permissions.iter().collect::<BTreeSet<_>>()
            && self.agencies.iter().map(|a| a.id).collect::<BTreeSet<_>>()
                == other.agencies.iter().map(|a| a.id).collect::<BTreeSet<_>>()
            && self
                .cash_registers
                .iter()
                .map(|r| (r.id, r.agency_id))
                .collect::<BTreeSet<_>>()
                == other
                    .cash_registers
                    .iter()
                    .map(|r| (r.id, r.agency_id))
                    .collect::<BTreeSet<_>>()
    }
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub state: String,
    pub profile: Option<Profile>,
    pub display_name: Option<String>,
    pub offline_until: Option<String>,
    pub reason: Option<String>,
    pub generation: u64,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub id: Uuid,
    pub kind: String,
    pub currency: String,
    pub amount: String,
    pub description: String,
    pub created_at: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_details: Option<ReceiptDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expense_details: Option<ExpenseDetails>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportingDocument {
    pub file_name: String,
    pub mime_type: String,
    pub data_base64: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptDetails {
    pub provenance: String,
    pub category: String,
    pub reference: String,
    pub supporting_document: Option<SupportingDocument>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpenseDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub beneficiary: String,
    pub reference: String,
    pub documents: Vec<SupportingDocument>,
}
impl SupportingDocument {
    pub(crate) fn validate(&self) -> crate::Result<usize> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        if self.file_name.trim().is_empty()
            || self.file_name.chars().count() > 160
            || self
                .file_name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            || self.data_base64.len() > 1398104
        {
            return Err(crate::Error::InvalidInput);
        }
        let bytes = STANDARD
            .decode(&self.data_base64)
            .map_err(|_| crate::Error::InvalidInput)?;
        if bytes.is_empty()
            || bytes.len() > 1048576
            || STANDARD.encode(&bytes) != self.data_base64
            || !match self.mime_type.as_str() {
                "application/pdf" => bytes.starts_with(b"%PDF-"),
                "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
                "image/jpeg" => bytes.starts_with(&[255, 216, 255]),
                _ => false,
            }
        {
            return Err(crate::Error::InvalidInput);
        }
        Ok(bytes.len())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftRecord {
    pub draft: Draft,
    pub agency_id: Uuid,
    pub cash_register_id: Option<Uuid>,
    pub version: u32,
    pub server_version: Option<u32>,
    #[serde(default)]
    pub server_id: Option<Uuid>,
    #[serde(default)]
    pub original_created_at: Option<String>,
    #[serde(default)]
    pub synchronized_at: Option<String>,
    #[serde(default)]
    pub last_attempt_at: Option<String>,
    #[serde(default)]
    pub next_attempt_at: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    pub state: String,
    pub result: Option<SyncResult>,
    pub updated_at: String,
    #[serde(default)]
    pub confirmed_receipt_id: Option<Uuid>,
    #[serde(default)]
    pub receipt_number: Option<String>,
    #[serde(default)]
    pub submitted_expense_id: Option<Uuid>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDraft {
    pub draft: Draft,
    pub agency_id: Uuid,
    pub cash_register_id: Option<Uuid>,
    pub expected_version: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncResult {
    pub draft_id: Uuid,
    pub outcome: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synchronized_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expense_request_id: Option<Uuid>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct PendingSync {
    pub record: DraftRecord,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct PendingTransfer {
    pub buffer: FormBuffer,
    pub server_id: Option<Uuid>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncNote {
    pub draft_id: Uuid,
    pub version: u32,
    pub code: String,
    pub at: String,
}

impl SyncResult {
    pub(crate) fn failure(id: Uuid, outcome: &str, code: &str) -> Self {
        Self {
            draft_id: id,
            outcome: outcome.into(),
            code: code.into(),
            server_id: None,
            server_version: None,
            synchronized_at: None,
            source_state: None,
            receipt_id: None,
            expense_request_id: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormBufferInput {
    pub id: Uuid,
    pub kind: String,
    pub agency_id: Uuid,
    pub cash_register_id: Option<Uuid>,
    pub expected_local_version: Option<u32>,
    pub fields: std::collections::HashMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormBuffer {
    pub id: Uuid,
    pub kind: String,
    pub agency_id: Uuid,
    pub cash_register_id: Option<Uuid>,
    pub expected_local_version: Option<u32>,
    pub fields: std::collections::HashMap<String, String>,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transmission_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transmitted_transfer_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transmission_changed: Option<bool>,
}
