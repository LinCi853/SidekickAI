fn main() {
    println!("cargo:rerun-if-env-changed=SIDEKICK_OXY_ORIGIN");
    println!("cargo:rustc-env=SIDEKICK_OXY_ORIGIN={}", std::env::var("SIDEKICK_OXY_ORIGIN").unwrap_or_default());
    println!("cargo:rerun-if-env-changed=SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON");
    println!("cargo:rustc-env=SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON={}", std::env::var("SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON").unwrap_or_else(|_| "[]".into()));
    println!("cargo:rerun-if-env-changed=SIDEKICK_RESOURCE_TRUST_KEYS_JSON");
    let keys = std::env::var("SIDEKICK_RESOURCE_TRUST_KEYS_JSON").unwrap_or_else(|_| "[]".into());
    println!("cargo:rustc-env=SIDEKICK_RESOURCE_TRUST_KEYS_JSON={keys}");
    println!("cargo:rerun-if-env-changed=SIDEKICK_BUILD_FINGERPRINT");
    println!("cargo:rustc-env=SIDEKICK_BUILD_FINGERPRINT={}", std::env::var("SIDEKICK_BUILD_FINGERPRINT").unwrap_or_default());
    tauri_build::build()
}
