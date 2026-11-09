use caissepro_session::{Broker, DraftRecord, SaveDraft, SessionView, SyncResult};
use serde_json::{json, Value};
use tauri::State;
use zeroize::Zeroizing;
type Reply<T> = std::result::Result<T, String>;
#[tauri::command]
pub async fn report_action(
    broker: State<'_, Broker>,
    action: String,
    payload: Option<Value>,
    expected_generation: u64,
) -> Reply<Value> {
    if ["save-pdf", "save-xlsx", "save-audit-pdf", "save-audit-xlsx"].contains(&action.as_str()) {
        use base64::Engine;
        let audit = action.starts_with("save-audit-");
        let format = if action.ends_with("-pdf") {
            "pdf"
        } else {
            "xlsx"
        };
        let scope = |view: &SessionView| {
            view.profile.as_ref().map(|p|json!({"user":p.user.id,"company":p.company.id,"version":p.authorization_version,"permissions":p.permissions,"agencies":p.agencies,"cash":p.cash_registers}))
        };
        let before = scope(&broker.status().map_err(safe)?);
        let result = if audit {
            broker
                .admin(
                    &format!("audit-{format}"),
                    payload,
                    Some(expected_generation),
                )
                .await
        } else {
            broker
                .report_action(format, payload, Some(expected_generation))
                .await
        }
        .map_err(safe)?;
        let name = result["fileName"]
            .as_str()
            .filter(|n| n.starts_with("CaissePro-") && !n.contains(['/', '\\']))
            .ok_or("SERVER_RESPONSE_INVALID")?;
        let encoded = result["dataBase64"]
            .as_str()
            .ok_or("SERVER_RESPONSE_INVALID")?;
        if encoded.len() > 1_800_000 {
            return Err("SERVER_RESPONSE_INVALID".into());
        }
        let bytes = zeroize::Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "SERVER_RESPONSE_INVALID")?,
        );
        if !name.ends_with(&format!(".{format}"))
            || (format == "pdf" && !bytes.starts_with(b"%PDF-"))
            || (format == "xlsx" && !bytes.starts_with(b"PK"))
        {
            return Err("SERVER_RESPONSE_INVALID".into());
        }
        let file = rfd::AsyncFileDialog::new()
            .set_file_name(name)
            .add_filter("Rapport financier", &[format])
            .save_file()
            .await;
        let Some(file) = file else {
            return Ok(json!({"saved":false}));
        };
        // Revalidate again after the user has interacted with the save dialog.
        broker
            .revalidate(Some(expected_generation))
            .await
            .map_err(safe)?;
        let view = broker.status().map_err(safe)?;
        if view.generation != expected_generation || view.state != "online" {
            return Err("SESSION_CHANGED".into());
        }
        let permission = if audit {
            "auth:logs:read"
        } else {
            "ledger:read"
        };
        if before != scope(&view)
            || !view
                .profile
                .as_ref()
                .is_some_and(|p| p.permissions.iter().any(|v| v == permission))
        {
            return Err("SESSION_CHANGED".into());
        }
        file.write(&bytes).await.map_err(|_| "REPORT_SAVE_FAILED")?;
        return Ok(json!({"saved":true}));
    }
    broker
        .report_action(&action, payload, Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn transfer_action(
    broker: State<'_, Broker>,
    action: String,
    payload: Option<Value>,
    expected_generation: u64,
) -> Reply<Value> {
    broker
        .transfer_action(&action, payload, Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn cash_catalog(broker: State<'_, Broker>, expected_generation: u64) -> Reply<Value> {
    broker
        .cash_catalog(Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn cash_action(
    broker: State<'_, Broker>,
    action: String,
    payload: Option<Value>,
    expected_generation: u64,
) -> Reply<Value> {
    broker
        .cash_action(&action, payload, Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn expense_action(
    broker: State<'_, Broker>,
    action: String,
    payload: Option<Value>,
    expected_generation: u64,
) -> Reply<Value> {
    broker
        .expense_action(&action, payload, Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn workspace_sync_action(
    broker: State<'_, Broker>,
    action: String,
    payload: Option<Value>,
    expected_generation: u64,
) -> Reply<Value> {
    broker
        .synchronization_action(&action, payload, Some(expected_generation))
        .await
        .map_err(safe)
}
fn safe(error: caissepro_session::Error) -> String {
    error.to_string()
}
#[tauri::command]
pub async fn auth_health(broker: State<'_, Broker>) -> Reply<Value> {
    broker.check_health().await.map_err(safe)
}
#[tauri::command]
pub async fn auth_login(
    broker: State<'_, Broker>,
    company_code: String,
    email: String,
    password: String,
) -> Reply<SessionView> {
    broker
        .login(company_code, email, Zeroizing::new(password))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn auth_status(broker: State<'_, Broker>) -> Reply<SessionView> {
    broker.tick().await.map_err(safe)
}
#[tauri::command]
pub async fn auth_logout(
    broker: State<'_, Broker>,
    expected_generation: u64,
) -> Reply<SessionView> {
    broker.logout(Some(expected_generation)).await.map_err(safe)
}
#[tauri::command]
pub async fn auth_lock(broker: State<'_, Broker>, expected_generation: u64) -> Reply<SessionView> {
    broker.lock(Some(expected_generation)).await.map_err(safe)
}
#[tauri::command]
pub async fn auth_unlock(
    broker: State<'_, Broker>,
    password: String,
    expected_generation: u64,
) -> Reply<SessionView> {
    broker
        .unlock(Zeroizing::new(password), Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn auth_revalidate(
    broker: State<'_, Broker>,
    expected_generation: u64,
) -> Reply<SessionView> {
    broker
        .revalidate(Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn auth_activity(
    broker: State<'_, Broker>,
    expected_generation: u64,
) -> Reply<SessionView> {
    broker
        .activity(Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn auth_password(
    broker: State<'_, Broker>,
    current_password: String,
    new_password: String,
    expected_generation: u64,
) -> Reply<SessionView> {
    broker
        .change_password(
            Zeroizing::new(current_password),
            Zeroizing::new(new_password),
            Some(expected_generation),
        )
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn workspace_balances(
    broker: State<'_, Broker>,
    expected_generation: u64,
) -> Reply<Value> {
    broker
        .balances(Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub fn workspace_drafts(
    broker: State<'_, Broker>,
    expected_generation: u64,
) -> Reply<Vec<DraftRecord>> {
    broker.drafts(Some(expected_generation)).map_err(safe)
}
#[tauri::command]
pub fn workspace_save_draft(
    broker: State<'_, Broker>,
    input: SaveDraft,
    expected_generation: u64,
) -> Reply<DraftRecord> {
    broker
        .save_draft(input, Some(expected_generation))
        .map_err(safe)
}
#[tauri::command]
pub async fn workspace_sync(
    broker: State<'_, Broker>,
    expected_generation: u64,
) -> Reply<Vec<SyncResult>> {
    broker
        .synchronize(Some(expected_generation))
        .await
        .map_err(safe)
}
#[tauri::command]
pub async fn admin_request(
    broker: State<'_, Broker>,
    action: String,
    payload: Option<Value>,
    expected_generation: u64,
) -> Reply<Value> {
    let value = broker
        .admin(&action, payload, Some(expected_generation))
        .await
        .map_err(safe)?;
    Ok(json!(value))
}
