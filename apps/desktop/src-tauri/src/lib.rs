pub use caissepro_local_store::PLATFORM_STORAGE_VALIDATED;
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Impossible de lancer CaissePro");
}
