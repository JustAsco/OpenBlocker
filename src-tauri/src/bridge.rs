//! Local HTTP bridge between OpenBlocker and its browser extension.
//!
//! The extension polls `GET http://127.0.0.1:47613/v1/rules` every couple of
//! seconds. Each request doubles as a heartbeat (so we know in which browsers
//! the extension runs) and reports the active tab for usage limits. The
//! bridge is served by the background service when it's installed, otherwise
//! by the app itself.
//!
//! Hardening (see [`crate::http::trusted`]):
//! * listens on 127.0.0.1 only and checks the `Host` header;
//! * sends no CORS headers, so web pages can't read the rules;
//! * requires an `X-OpenBlocker` header, which pages can't add without a
//!   CORS preflight that we never approve, so they can't fake heartbeats;
//! * on Windows the calling browser is identified from the TCP connection's
//!   owning process instead of trusting what the caller says.

use crate::http;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PORT: u16 = 47613;
/// A browser counts as protected if its extension checked in this recently.
pub const HEARTBEAT_TIMEOUT_MS: i64 = 45_000;
/// A browser is only closed for a missing extension after this much silence:
/// browsers may suspend the extension's background script or delay its
/// wake-up alarm for a while, and closing someone's browser by mistake is
/// far worse than a short gap.
pub const CLOSE_AFTER_SILENCE_MS: i64 = 120_000;
/// The reported active tab is trusted for usage limits this long.
pub const ACTIVE_TAB_TIMEOUT_MS: i64 = 6_000;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSeen {
    pub exe: String,
    pub name: String,
    pub last_seen: i64,
    pub extension_version: String,
    /// URL of the active tab while the browser window has focus and the user
    /// isn't idle (reported by the extension; used for usage limits).
    #[serde(default)]
    pub active_url: Option<String>,
    /// Whether the extension may run in private/incognito windows (None =
    /// an older extension that doesn't say).
    #[serde(default)]
    pub incognito: Option<bool>,
    /// YouTube subscriptions the extension could read while they're needed:
    /// the number of channels, or -1 when the browser isn't signed in to
    /// YouTube or the page couldn't be read (None = not needed or unknown).
    #[serde(default)]
    pub youtube_subscriptions: Option<i64>,
}

/// What the extension should enforce right now.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    /// Domains to block (subdomains included).
    pub blocked: Vec<String>,
    /// Parts of websites to block, e.g. `youtube.com/shorts` (the path and
    /// everything below it, on the domain and its subdomains). A separate
    /// field so older extension versions simply ignore it.
    pub blocked_paths: Vec<String>,
    /// Parts of blocked sites that stay reachable (list exceptions such as
    /// `reddit.com/r/rust`). They win over `blocked` and `blocked_paths`.
    pub allowed_paths: Vec<String>,
    /// When set, *only* these domains may be opened.
    pub allow_only: Option<Vec<String>>,
    /// Latest end of the active blocks, so a stale rule set can expire if the
    /// app disappears.
    pub until: Option<i64>,
    /// Names of the active lists, shown on the block page.
    pub lists: Vec<String>,
    /// When set, YouTube videos may only play from these channels
    /// (`@handle`, `UC…` id, `c/name` or `user/name`).
    pub youtube_channels: Option<Vec<String>>,
    /// While `youtube_channels` is set: channels the user is subscribed to
    /// may play too.
    pub youtube_subscriptions: bool,
    /// Subscriptions are allowed by a locked block: refreshing them may drop
    /// channels but never add new ones.
    pub youtube_subscriptions_locked: bool,
    /// Hide Shorts/Reels shelves in feeds while their pages are blocked.
    pub hide_short_video_feeds: bool,
    /// Version of the extension that ships with this app. An older extension
    /// reloads itself (an unpacked one then picks up the updated files).
    pub latest_version: &'static str,
    /// Browsers whose extension isn't allowed in private windows get closed
    /// after a warning; the extension explains how to allow it.
    pub private_windows_required: bool,
    /// The user may choose to not include private windows instead.
    pub private_windows_opt_out: bool,
}

/// Version in `extension/manifest.json`, the extension this build ships with.
pub fn extension_version() -> &'static str {
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../extension/manifest.json"))
            .ok()
            .and_then(|m| m["version"].as_str().map(str::to_string))
            .unwrap_or_default()
    })
}

#[derive(Default)]
pub struct Bridge {
    seen: Mutex<HashMap<String, BrowserSeen>>,
    /// (revision, serialised rules with the revision included)
    rules: Mutex<Arc<(String, String)>>,
    pub error: Mutex<Option<String>>,
    /// Websites whose block page was shown, as reported by the extension,
    /// not yet picked up for the statistics.
    site_hits: Mutex<Vec<String>>,
}

/// Parses the extension's block-page report: `domain*count,domain*count`.
/// Only plausible domains and counts are taken.
pub fn parse_site_hits(raw: &str) -> Vec<String> {
    let mut out = vec![];
    for item in raw.split(',').take(50) {
        let (domain, n) = item.split_once('*').unwrap_or((item, "1"));
        let Some(domain) = openblocker_core::hosts::normalize_domain(domain) else { continue };
        let n = n.parse::<usize>().unwrap_or(1).clamp(1, 100);
        out.extend(std::iter::repeat_n(domain, n));
    }
    out
}

impl Bridge {
    /// Block-page views reported since the last call.
    pub fn take_site_hits(&self) -> Vec<String> {
        std::mem::take(&mut *self.site_hits.lock().unwrap())
    }

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

    /// The extension checked in from this browser recently enough. Browsers
    /// may suspend it or delay its wake-ups for a while, and closing someone's
    /// browser by mistake is far worse than a short gap.
    pub fn alive(&self, exe: &str, now_ms: i64) -> bool {
        self.seen
            .lock()
            .unwrap()
            .get(&exe.to_lowercase())
            .is_some_and(|b| now_ms - b.last_seen < CLOSE_AFTER_SILENCE_MS)
    }

    /// The extension runs in this browser but isn't allowed in private windows.
    pub fn private_windows_missing(&self, exe: &str, now_ms: i64) -> bool {
        self.seen
            .lock()
            .unwrap()
            .get(&exe.to_lowercase())
            .is_some_and(|b| now_ms - b.last_seen < CLOSE_AFTER_SILENCE_MS && b.incognito == Some(false))
    }

    /// Publishes new rules. Serialising once here keeps big community lists
    /// cheap: polls with the current revision get a tiny "unchanged" answer.
    pub fn set_rules(&self, rules: &Rules) {
        let json = serde_json::to_string(rules).unwrap_or_else(|_| "{}".into());
        let rev = format!("{:016x}", fnv1a(json.as_bytes()));
        let mut cur = self.rules.lock().unwrap();
        if cur.0 != rev {
            let with_rev = format!("{{\"rev\":\"{rev}\",{}", &json[1..]);
            *cur = Arc::new((rev, with_rev));
        }
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// URL of the active tab in a browser, if the report is fresh.
pub fn active_url(browsers: &[BrowserSeen], exe: &str, now_ms: i64) -> Option<String> {
    browsers
        .iter()
        .find(|b| b.exe.eq_ignore_ascii_case(exe) && now_ms - b.last_seen < ACTIVE_TAB_TIMEOUT_MS)
        .and_then(|b| b.active_url.clone())
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

/// Serves the bridge whenever `active()` is true, giving the port up while
/// it's false (the app hands the bridge over to the background service this
/// way). Runs forever; call from a dedicated thread.
pub fn run(bridge: Arc<Bridge>, active: impl Fn() -> bool) {
    loop {
        if !active() {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(server) => {
                *bridge.error.lock().unwrap() = None;
                let stop = AtomicBool::new(false);
                while !stop.load(Ordering::Relaxed) {
                    match server.recv_timeout(Duration::from_millis(500)) {
                        Ok(Some(req)) => handle(&bridge, req),
                        Ok(None) => {}
                        Err(_) => break,
                    }
                    if !active() {
                        stop.store(true, Ordering::Relaxed);
                    }
                }
            }
            Err(e) => {
                *bridge.error.lock().unwrap() = Some(format!("Browser extension bridge unavailable (port {PORT}): {e}"));
                std::thread::sleep(Duration::from_secs(3));
            }
        }
    }
}

fn handle(bridge: &Bridge, req: tiny_http::Request) {
    let url = req.url().to_string();
    if req.method() != &tiny_http::Method::Get || !url.starts_with("/v1/rules") || !http::trusted(&req, "X-OpenBlocker", PORT) {
        let _ = req.respond(tiny_http::Response::empty(404));
        return;
    }
    let hint = http::query_param(&url, "b").unwrap_or("");
    if let Some(raw) = http::query_param(&url, "bh") {
        let hits = parse_site_hits(&http::percent_decode(raw));
        let mut pending = bridge.site_hits.lock().unwrap();
        if pending.len() < 10_000 {
            pending.extend(hits);
        }
    }
    let version = http::query_param(&url, "v").unwrap_or("").chars().take(20).collect::<String>();
    let active_url = http::query_param(&url, "a")
        .map(http::percent_decode)
        .filter(|u| !u.is_empty() && u.len() < 4096);
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
                active_url,
                incognito: http::query_param(&url, "i").map(|v| v == "1"),
                youtube_subscriptions: http::query_param(&url, "ys").and_then(|v| v.parse::<i64>().ok()).map(|n| n.clamp(-1, 100_000)),
            },
        );
    }
    let rules = bridge.rules.lock().unwrap().clone();
    let body = if http::query_param(&url, "r") == Some(rules.0.as_str()) {
        format!("{{\"rev\":\"{}\",\"unchanged\":true}}", rules.0)
    } else if rules.0.is_empty() {
        serde_json::to_string(&Rules::default()).unwrap()
    } else {
        rules.1.clone()
    };
    let no_store = tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body).with_header(http::json_header()).with_header(no_store));
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

#[cfg(test)]
mod site_hit_tests {
    use super::parse_site_hits;

    #[test]
    fn parses_block_page_reports() {
        assert_eq!(parse_site_hits("youtube.com*2,www.reddit.com"), ["youtube.com", "youtube.com", "reddit.com"]);
        // Junk is dropped, counts are capped.
        assert!(parse_site_hits("not a domain*5,,*").is_empty());
        assert_eq!(parse_site_hits("x.com*999999").len(), 100);
        assert_eq!(parse_site_hits(&"a.com,".repeat(500)).len(), 50);
    }
}
