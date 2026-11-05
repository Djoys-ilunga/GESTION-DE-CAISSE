use caissepro_session::{Broker, DraftRecord, SaveDraft, SessionView, SyncResult};
use serde_json::{json, Value};
use tauri::State;
use zeroize::Zeroizing;
type Reply<T> = std::result::Result<T, String>;
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
