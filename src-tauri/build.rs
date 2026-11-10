fn main() {
    let mut attributes = tauri_build::Attributes::new();
    // Release builds always ask for administrator rights (needed for the hosts
    // file). Debug builds don't, because `cargo run`/`tauri dev` cannot start an
    // elevated program from a normal terminal (error 740); use an admin terminal
    // or the in-app "Restart as administrator" button while developing.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app-manifest.xml")),
        );
    }
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
