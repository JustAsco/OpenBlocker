//! Turning the state into actual blocking: hosts file, closing apps and
//! browsers without the extension, and the rules served to the extension.
//! Used by the background service, or by the app itself when no service runs.

use crate::{bridge, platform};
use chrono::NaiveDateTime;
use openblocker_core::engine::{self, ActiveBlock};
use openblocker_core::hosts;
use openblocker_core::model::{ExtensionFallback, PrivateWindows, State};
use std::collections::BTreeSet;

/// Private windows are checked: extension-only features are active and the
/// setting isn't Off.
pub fn private_windows_required(state: &State, active: &[ActiveBlock]) -> bool {
    state.settings.private_windows != PrivateWindows::Off && engine::needs_extension(state, active)
}

pub fn extension_rules(state: &State, active: &[ActiveBlock]) -> bridge::Rules {
    let (sites, _) = engine::enforced_targets(state, active);
    let allowed = engine::allowed_sites(state, active);
    let (paths, domains): (Vec<String>, Vec<String>) = sites.into_iter().partition(|s| hosts::is_path_site(s));
    // A path on a domain that is blocked anyway adds nothing.
    let blocked: BTreeSet<&str> = domains.iter().map(String::as_str).collect();
    let paths = paths.into_iter().filter(|p| !blocked.contains(hosts::site_domain(p))).collect();
    let mut lists: Vec<String> = active.iter().filter_map(|b| state.list(&b.list_id).map(|l| l.name.clone())).collect();
    lists.sort();
    lists.dedup();
    bridge::Rules {
        blocked: domains,
        blocked_paths: paths,
        allowed_paths: engine::excepted_paths(state, active).into_iter().collect(),
        allow_only: allowed.map(|a| a.into_iter().collect()),
        until: active.iter().map(|b| b.ends_at).max(),
        lists,
        youtube_channels: engine::youtube_channels(state, active).map(|c| c.into_iter().collect()),
        hide_short_video_feeds: state.settings.hide_short_video_feeds,
        latest_version: bridge::extension_version(),
        private_windows_required: private_windows_required(state, active),
        private_windows_opt_out: state.settings.private_windows == PrivateWindows::Default,
    }
}

/// A browser is closed this long after the warning.
pub const BROWSER_WARNING_MS: i64 = 60_000;

/// Why a browser is about to be closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    /// The extension ran in it during the current block and then stopped
    /// (disabled or removed).
    Deactivated,
    /// The extension runs, but isn't allowed in private windows.
    PrivateWindows,
    /// "Close browsers without the extension" is on and it has none.
    Missing,
}

/// Something to tell the user about a browser that will be, or was, closed.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNotice {
    /// Friendly name, e.g. "Google Chrome".
    pub browser: String,
    /// true: it was closed now; false: it will be closed in a minute.
    pub closed: bool,
    pub reason: CloseReason,
}

#[derive(Default)]
pub struct Outcome {
    /// Executables closed this round.
    pub killed: Vec<String>,
    /// Browsers about to be closed, or closed, for lacking the extension.
    pub browser_notices: Vec<BrowserNotice>,
}

pub struct Enforcer {
    killer: platform::ProcessKiller,
    /// What's in the hosts file now (None = unknown, rewrite).
    applied: Option<(BTreeSet<String>, bool)>,
    pub hosts_error: Option<String>,
    retry_at: i64,
    /// Browsers found without the extension: exe -> when they were warned.
    warned: std::collections::HashMap<String, i64>,
    /// Browsers in which the extension ran since the current blocks began.
    had_extension: BTreeSet<String>,
}

impl Default for Enforcer {
    fn default() -> Self {
        Self::new()
    }
}

impl Enforcer {
    pub fn new() -> Self {
        Self {
            killer: platform::ProcessKiller::new(),
            applied: None,
            hosts_error: None,
            retry_at: 0,
            warned: Default::default(),
            had_extension: BTreeSet::new(),
        }
    }

    /// Forget what was written, e.g. after something else touched the hosts
    /// file, so the next round rewrites it (and retries after an error now).
    pub fn invalidate(&mut self) {
        self.applied = None;
        self.retry_at = 0;
    }

    /// One enforcement round.
    pub fn run(&mut self, state: &State, bridge: &bridge::Bridge, now_ms: i64, local: &NaiveDateTime) -> Outcome {
        let blocks = engine::active_blocks(state, now_ms, local);
        let (mut sites, mut apps) = engine::enforced_targets(state, &blocks);
        // A site with an excepted path can't be in the hosts file (that would
        // block the excepted part too); the extension blocks the rest of it.
        // Without the extension anywhere, features only it can enforce either
        // block the whole site (strict) or leave it open (lenient).
        let ext_features = engine::needs_extension(state, &blocks);
        let connected = bridge.connected(now_ms);
        let strict = ext_features && connected.is_empty() && state.settings.extension_fallback == ExtensionFallback::Strict;
        if strict {
            sites.extend(engine::strict_fallback_domains(state, &blocks));
        } else {
            // A site with an excepted path can't be in the hosts file (that
            // would block the excepted part too); the extension blocks the rest.
            let excepted = engine::excepted_paths(state, &blocks);
            sites.retain(|s| {
                !excepted
                    .iter()
                    .any(|p| hosts::site_domain(p) == s || hosts::site_domain(p).ends_with(&format!(".{s}")))
            });
        }
        if state.freeze.is_some() && state.settings.freeze_blocks_task_manager {
            apps.insert("taskmgr.exe".into());
        }
        let subdomains = state.settings.block_subdomains;
        let key = (sites, subdomains);
        if self.applied.as_ref() != Some(&key) && now_ms >= self.retry_at {
            // Community lists usually contain their www. variants already.
            let from_sources = |d: &str| state.source_sites.values().any(|s| s.contains(d));
            match platform::apply_hosts(&key.0, subdomains, |d| !from_sources(d)) {
                Ok(changed) => {
                    if changed && state.settings.flush_dns {
                        platform::flush_dns();
                    }
                    self.applied = Some(key);
                    self.hosts_error = None;
                }
                Err(e) => {
                    self.hosts_error = Some(e);
                    self.retry_at = now_ms + 15_000;
                }
            }
        }
        bridge.set_rules(&extension_rules(state, &blocks));
        let mut out = Outcome {
            killed: self.killer.enforce(&apps),
            ..Default::default()
        };
        // Closing browsers: never just because the extension isn't installed
        // (unless the user opted in), only when it was switched off during a
        // block, or can't see private windows while that's required.
        let websites = !engine::enforced_targets(state, &blocks).0.is_empty() || ext_features;
        if websites {
            self.had_extension.extend(connected.iter().map(|b| b.exe.to_lowercase()));
        } else {
            self.had_extension.clear();
        }
        let private_required = private_windows_required(state, &blocks);
        let reason = |exe: &str| -> Option<CloseReason> {
            if !websites {
                return None;
            }
            let alive = bridge.alive(exe, now_ms);
            if alive {
                (private_required && bridge.private_windows_missing(exe, now_ms)).then_some(CloseReason::PrivateWindows)
            } else if self.had_extension.contains(exe) {
                Some(CloseReason::Deactivated)
            } else if state.settings.require_extension {
                Some(CloseReason::Missing)
            } else {
                None
            }
        };
        // Warn first, close a minute later: closing a browser out of the blue
        // looks like a crash.
        let found: Vec<(String, String, CloseReason)> = self
            .killer
            .unprotected_browsers(|exe| reason(exe).is_none())
            .into_iter()
            .filter_map(|(exe, name)| reason(&exe).map(|r| (exe, name, r)))
            .collect();
        self.warned.retain(|exe, _| found.iter().any(|(e, _, _)| e == exe));
        for (exe, name, reason) in found {
            match self.warned.get(&exe) {
                None => {
                    self.warned.insert(exe, now_ms);
                    out.browser_notices.push(BrowserNotice { browser: name, closed: false, reason });
                }
                Some(at) if now_ms - at >= BROWSER_WARNING_MS => {
                    if self.killer.close_browser(&exe) {
                        out.browser_notices.push(BrowserNotice { browser: name, closed: true, reason });
                    }
                    self.warned.remove(&exe);
                    // Closed for good reason; if it comes back without the
                    // extension, it gets a new warning.
                }
                Some(_) => {}
            }
        }
        out
    }

    /// Removes our hosts section (when quitting with nothing locked).
    pub fn clear(&mut self) {
        let _ = platform::apply_hosts(&BTreeSet::new(), false, |_| true);
        self.applied = None;
    }
}
