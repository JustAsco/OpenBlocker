//! Turning the state into actual blocking: hosts file, closing apps and
//! browsers without the extension, and the rules served to the extension.
//! Used by the background service, or by the app itself when no service runs.

use crate::{bridge, platform};
use chrono::NaiveDateTime;
use openblocker_core::engine::{self, ActiveBlock};
use openblocker_core::hosts;
use openblocker_core::model::State;
use std::collections::BTreeSet;

/// Allowlists can only be enforced by the extension, so browsers without it
/// are closed while one is active (or always, if the user opted in).
pub fn extension_required(state: &State, active: &[ActiveBlock]) -> bool {
    engine::allowed_sites(state, active).is_some() || (state.settings.require_extension && !engine::enforced_targets(state, active).0.is_empty())
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
        allow_only: allowed.map(|a| a.into_iter().collect()),
        until: active.iter().map(|b| b.ends_at).max(),
        lists,
    }
}

#[derive(Default)]
pub struct Outcome {
    /// Executables closed this round.
    pub killed: Vec<String>,
    /// Browsers closed because the extension wasn't running in them.
    pub closed_browsers: Vec<String>,
}

pub struct Enforcer {
    killer: platform::ProcessKiller,
    /// What's in the hosts file now (None = unknown, rewrite).
    applied: Option<(BTreeSet<String>, bool)>,
    pub hosts_error: Option<String>,
    retry_at: i64,
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
        let (sites, mut apps) = engine::enforced_targets(state, &blocks);
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
        if extension_required(state, &blocks) {
            out.closed_browsers = self.killer.close_unprotected_browsers(|exe| bridge.is_connected(exe, now_ms));
        }
        out
    }

    /// Removes our hosts section (when quitting with nothing locked).
    pub fn clear(&mut self) {
        let _ = platform::apply_hosts(&BTreeSet::new(), false, |_| true);
        self.applied = None;
    }
}
