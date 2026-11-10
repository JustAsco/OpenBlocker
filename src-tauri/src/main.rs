// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    match arg.as_str() {
        // Started by the Windows Service Control Manager.
        #[cfg(windows)]
        "--service" => {
            if let Err(e) = openblocker_lib::service::windows_service_main::run() {
                eprintln!("OpenBlocker service: {e}");
                std::process::exit(1);
            }
        }
        // The service loop in the foreground, for development.
        "--service-console" => openblocker_lib::service::run_console(),
        // Used by the installer: exit code 1 while something is locked.
        "--uninstall-check" => std::process::exit(openblocker_lib::service::uninstall_check()),
        _ => openblocker_lib::run(),
    }
}
