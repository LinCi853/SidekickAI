fn main() {
    println!("cargo:rerun-if-env-changed=SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON");
    let keys = std::env::var("SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON").unwrap_or_else(|_| "[]".into());
    println!("cargo:rustc-env=SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON={keys}");
    println!("cargo:rerun-if-env-changed=SIDEKICK_BUILD_FINGERPRINT");
    println!("cargo:rustc-env=SIDEKICK_BUILD_FINGERPRINT={}", std::env::var("SIDEKICK_BUILD_FINGERPRINT").unwrap_or_default());
}
