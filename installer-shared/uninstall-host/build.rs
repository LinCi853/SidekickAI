fn main() {
    println!("cargo:rerun-if-env-changed=SIDEKICK_BUILD_FINGERPRINT");
    println!("cargo:rustc-env=SIDEKICK_BUILD_FINGERPRINT={}", std::env::var("SIDEKICK_BUILD_FINGERPRINT").unwrap_or_default());
}
