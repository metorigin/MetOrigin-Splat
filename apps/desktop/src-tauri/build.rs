fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Custom Windows icons must invalidate the cached PE resource object,
        // independently of the default window icon embedded by codegen.
        println!("cargo:rerun-if-changed=icons/windows/icon.ico");
        println!("cargo:rerun-if-changed=icons/windows/manifest.json");
    }
    tauri_build::build()
}
