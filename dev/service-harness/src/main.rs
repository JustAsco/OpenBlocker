//! The service modules of the app, compiled without Tauri. Run with
//! `OPENBLOCKER_SERVICE_DIR=/tmp/ob cargo run` (it never needs root: the hosts
//! file write simply fails and is reported).
#![allow(dead_code)]

#[path = "../../../src-tauri/src/bridge.rs"]
mod bridge;
#[path = "../../../src-tauri/src/enforce.rs"]
mod enforce;
#[path = "../../../src-tauri/src/http.rs"]
mod http;
#[path = "../../../src-tauri/src/password.rs"]
mod password;
#[path = "../../../src-tauri/src/platform.rs"]
mod platform;
#[path = "../../../src-tauri/src/service.rs"]
mod service;

fn main() {
    service::run_console();
}
