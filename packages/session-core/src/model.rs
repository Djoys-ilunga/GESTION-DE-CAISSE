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
        self.permissions.iter().collect::<BTreeSet<_>>()
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
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftRecord {
    pub draft: Draft,
    pub agency_id: Uuid,
    pub cash_register_id: Option<Uuid>,
    pub version: u32,
    pub server_version: Option<u32>,
    pub state: String,
    pub result: Option<SyncResult>,
    pub updated_at: String,
    #[serde(default)]
    pub confirmed_receipt_id: Option<Uuid>,
    #[serde(default)]
    pub receipt_number: Option<String>,
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
}
