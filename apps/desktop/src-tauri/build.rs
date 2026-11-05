fn main() {
    // Seules ces deux valeurs publiques sont embarquées. Jamais DATABASE_URL.
    let path = std::path::Path::new("../../../.env");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(path).unwrap_or_default();
    for (name, fallback) in [
        ("VITE_API_BASE_URL", "https://unconfigured.invalid"),
        ("VITE_API_DEPLOYMENT_ID", "unconfigured"),
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name)
            .ok()
            .or_else(|| {
                text.lines().find_map(|line| {
                    line.strip_prefix(&format!("{name}="))
                        .map(|v| v.trim().trim_matches(['\"', '\'']).to_owned())
                })
            })
            .unwrap_or_else(|| fallback.into());
        assert!(
            !value.contains(['\n', '\r']),
            "Configuration publique invalide"
        );
        println!("cargo:rustc-env={name}={value}");
    }
    let manifest = tauri_build::AppManifest::new().commands(&[
        "cash_catalog",
        "cash_action",
        "auth_health",
        "auth_login",
        "auth_status",
        "auth_logout",
        "auth_lock",
        "auth_unlock",
        "auth_revalidate",
        "auth_activity",
        "auth_password",
        "workspace_balances",
        "workspace_drafts",
        "workspace_save_draft",
        "workspace_sync",
        "admin_request",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Configuration CaissePro invalide");
}
