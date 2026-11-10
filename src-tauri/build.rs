fn main() {
    let mut attributes = tauri_build::Attributes::new();
    // Release builds embed the app manifest (common controls for dialogs).
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app-manifest.xml")),
        );
    }
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
