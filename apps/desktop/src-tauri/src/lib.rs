pub use caissepro_local_store::PLATFORM_STORAGE_VALIDATED;
mod commands;
use tauri::Manager;
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let broker = caissepro_session::Broker::with_native_storage(
                env!("VITE_API_BASE_URL"),
                env!("VITE_API_DEPLOYMENT_ID"),
                app.path().app_local_data_dir()?.join("encrypted-drafts"),
                cfg!(debug_assertions),
            )?;
            app.manage(broker);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cash_catalog,
            commands::cash_action,
            commands::transfer_action,
            commands::report_action,
            commands::expense_action,
            commands::auth_health,
            commands::auth_login,
            commands::auth_status,
            commands::auth_logout,
            commands::auth_lock,
            commands::auth_unlock,
            commands::auth_revalidate,
            commands::auth_activity,
            commands::auth_password,
            commands::workspace_balances,
            commands::workspace_drafts,
            commands::workspace_save_draft,
            commands::workspace_sync,
            commands::workspace_sync_action,
            commands::admin_request
        ])
        .run(tauri::generate_context!())
        .expect("Impossible de lancer CaissePro");
}
