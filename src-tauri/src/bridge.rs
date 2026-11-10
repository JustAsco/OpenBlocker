//! Local HTTP bridge between the app and the OpenBlocker browser extension.
//!
//! The extension polls `GET http://127.0.0.1:47613/v1/rules` every couple of
//! seconds. Each request doubles as a heartbeat, so the app knows in which
//! browsers the extension is running.
//!
//! Hardening:
//! * listens on 127.0.0.1 only;
//! * sends no CORS headers, so ordinary web pages can't read the rules
//!   (the extension has host permissions and doesn't need CORS);
//! * requires an `X-OpenBlocker` header, which pages can't add without a
//!   CORS preflight that we never approve, so they can't fake heartbeats;
//! * on Windows the calling browser is identified from the TCP connection's
//!   owning process instead of trusting what the caller says.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const PORT: u16 = 47613;
/// A browser counts as protected if its extension checked in this recently.
pub const HEARTBEAT_TIMEOUT_MS: i64 = 45_000;

/// Browsers whose processes can be closed when they run without the extension.
pub const BROWSERS: &[(&str, &str)] = &[
    ("chrome.exe", "Google Chrome"),
    ("msedge.exe", "Microsoft Edge"),
    ("firefox.exe", "Firefox"),
    ("brave.exe", "Brave"),
    ("opera.exe", "Opera"),
    ("vivaldi.exe", "Vivaldi"),
    ("chromium.exe", "Chromium"),
    ("librewolf.exe", "LibreWolf"),
    ("waterfox.exe", "Waterfox"),
    ("floorp.exe", "Floorp"),
    ("zen.exe", "Zen"),
    ("arc.exe", "Arc"),
];

pub fn browser_name(exe: &str) -> Option<&'static str> {
    BROWSERS.iter().find(|(e, _)| e.eq_ignore_ascii_case(exe)).map(|(_, n)| *n)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSeen {
    pub exe: String,
    pub name: String,
    pub last_seen: i64,
    pub extension_version: String,
}

/// What the extension should enforce right now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    /// Domains to block (subdomains included).
    pub blocked: Vec<String>,
    /// When set, *only* these domains may be opened.
    pub allow_only: Option<Vec<String>>,
    /// Latest end of the active blocks, so a stale rule set can expire if the
    /// app disappears.
    pub until: Option<i64>,
    /// Names of the active lists, shown on the block page.
    pub lists: Vec<String>,
}

#[derive(Default)]
pub struct Bridge {
    seen: Mutex<HashMap<String, BrowserSeen>>,
    pub error: Mutex<Option<String>>,
}

impl Bridge {
    /// Browsers with a recent heartbeat.
    pub fn connected(&self, now_ms: i64) -> Vec<BrowserSeen> {
        let mut v: Vec<_> = self
            .seen
            .lock()
            .unwrap()
            .values()
            .filter(|b| now_ms - b.last_seen < HEARTBEAT_TIMEOUT_MS)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    pub fn is_connected(&self, exe: &str, now_ms: i64) -> bool {
        self.seen
            .lock()
            .unwrap()
            .get(&exe.to_lowercase())
            .is_some_and(|b| now_ms - b.last_seen < HEARTBEAT_TIMEOUT_MS)
    }
}

fn exe_from_hint(hint: &str) -> Option<&'static str> {
    Some(match hint {
        "chrome" => "chrome.exe",
        "edge" => "msedge.exe",
        "firefox" => "firefox.exe",
        "brave" => "brave.exe",
        "opera" => "opera.exe",
        "vivaldi" => "vivaldi.exe",
        _ => return None,
    })
}

fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    url.split_once('?')?
        .1
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

/// Runs the bridge server forever (call from a dedicated thread).
pub fn serve(bridge: Arc<Bridge>, rules: impl Fn() -> Rules) {
    let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(e) => {
            *bridge.error.lock().unwrap() = Some(format!("Browser extension bridge unavailable (port {PORT}): {e}"));
            return;
        }
    };
    let json = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let no_store = tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap();
    for req in server.incoming_requests() {
        let authorised = req.headers().iter().any(|h| h.field.equiv("X-OpenBlocker"));
        let url = req.url().to_string();
        if req.method() != &tiny_http::Method::Get || !url.starts_with("/v1/rules") || !authorised {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        }
        let hint = query_param(&url, "b").unwrap_or("");
        let version = query_param(&url, "v").unwrap_or("").chars().take(20).collect::<String>();
        let peer_port = req.remote_addr().map(|a| a.port()).unwrap_or(0);
        let exe = owning_exe(peer_port)
            .filter(|e| browser_name(e).is_some())
            .or_else(|| exe_from_hint(hint).map(String::from));
        if let Some(exe) = exe {
            let exe = exe.to_lowercase();
            let name = browser_name(&exe).unwrap_or("Browser").to_string();
            bridge.seen.lock().unwrap().insert(
                exe.clone(),
                BrowserSeen {
                    exe,
                    name,
                    last_seen: chrono::Utc::now().timestamp_millis(),
                    extension_version: version,
                },
            );
        }
        let body = serde_json::to_string(&rules()).unwrap_or_else(|_| "{}".into());
        let resp = tiny_http::Response::from_string(body)
            .with_header(json.clone())
            .with_header(no_store.clone());
        let _ = req.respond(resp);
    }
}

/// Executable name of the process owning the client side of a loopback TCP
/// connection to our port.
#[cfg(windows)]
fn owning_exe(client_port: u16) -> Option<String> {
    use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL};
    use windows::Win32::Networking::WinSock::AF_INET;
    if client_port == 0 {
        return None;
    }
    let pid = unsafe {
        let mut size = 0u32;
        let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0);
        if size == 0 {
            return None;
        }
        // u32 buffer keeps the table properly aligned.
        let mut buf = vec![0u32; (size as usize).div_ceil(4) + 1];
        if GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0) != 0 {
            return None;
        }
        let count = buf[0] as usize;
        let rows = std::slice::from_raw_parts(buf.as_ptr().add(1) as *const MIB_TCPROW_OWNER_PID, count);
        // Ports are stored in network byte order in the low 16 bits.
        let port = |p: u32| u16::from_be(p as u16);
        rows.iter()
            .find(|r| port(r.dwLocalPort) == client_port && port(r.dwRemotePort) == PORT)
            .map(|r| r.dwOwningPid)?
    };
    let mut sys = sysinfo::System::new().ok()?;
    let pid = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), false);
    sys.process(pid).map(|p| p.name().to_string_lossy().to_string())
}

#[cfg(not(windows))]
fn owning_exe(_client_port: u16) -> Option<String> {
    None
}
