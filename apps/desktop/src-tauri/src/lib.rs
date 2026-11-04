pub use caissepro_local_store::PLATFORM_STORAGE_VALIDATED;
mod commands;
pub fn run() {
    let broker = caissepro_session::Broker::new(
        env!("VITE_API_BASE_URL"),
        env!("VITE_API_DEPLOYMENT_ID"),
        uuid::Uuid::new_v4(),
        cfg!(debug_assertions),
    )
    .expect("Configuration du serveur invalide");
    tauri::Builder::default()
        .manage(broker)
        .invoke_handler(tauri::generate_handler![
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
            commands::admin_request
        ])
        .run(tauri::generate_context!())
        .expect("Impossible de lancer CaissePro");
}
