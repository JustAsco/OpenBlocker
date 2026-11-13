//! Pure time-based logic: which lists are active right now, advancing
//! timers, and lock rules. No I/O happens here so it is fully unit-testable.

use crate::model::*;
use chrono::{Datelike, NaiveDateTime, Timelike};
use serde::Serialize;
use std::collections::BTreeSet;

pub const MINUTE_MS: i64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Session,
    Schedule,
    Pomodoro,
    /// A daily usage limit that has been used up.
    Limit,
    /// A block that runs until turned off.
    Permanent,
}

/// One reason a list is currently being enforced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBlock {
    pub list_id: String,
    pub source: Source,
    /// Id of the session/schedule, or "pomodoro".
    pub ref_id: String,
    pub ends_at: i64,
    pub locked: bool,
    /// Locked, but the unlock password can end it early.
    pub password: bool,
}

/// Something noteworthy that happened during a [`tick`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    SessionEnded { list_id: String },
    PomodoroPhase { phase: PomodoroPhase, round: u32 },
    PomodoroFocusCompleted,
    PomodoroFinished,
    FreezeEnded,
}

/// Minutes since local midnight and weekday (0 = Monday).
fn clock(local: &NaiveDateTime) -> (u16, u8) {
    (
        (local.hour() * 60 + local.minute()) as u16,
        local.weekday().num_days_from_monday() as u8,
    )
}

/// If `schedule` is running at local time `local`, returns how many ms remain.
pub fn schedule_remaining_ms(schedule: &Schedule, local: &NaiveDateTime) -> Option<i64> {
    let (m, d) = clock(local);
    let yesterday = (d + 6) % 7;
    let has = |day: u8| schedule.days.contains(&day);
    let (s, e) = (schedule.start, schedule.end);
    let minutes_left: i64 = if s == e {
        // Whole day.
        if !has(d) {
            return None;
        }
        1440 - m as i64
    } else if s < e {
        if !(has(d) && s <= m && m < e) {
            return None;
        }
        (e - m) as i64
    } else if has(d) && m >= s {
        // Overnight, first part.
        (1440 - m as i64) + e as i64
    } else if has(yesterday) && m < e {
        // Overnight, continuing from yesterday.
        (e - m) as i64
    } else {
        return None;
    };
    let into_minute = local.second() as i64 * 1000 + (local.nanosecond() / 1_000_000) as i64;
    Some(minutes_left * MINUTE_MS - into_minute)
}

/// Local date key `YYYY-MM-DD`, as used by stats and usage.
pub fn date_key(local: &NaiveDateTime) -> String {
    local.format("%Y-%m-%d").to_string()
}

/// Milliseconds until the next local midnight.
pub fn ms_until_midnight(local: &NaiveDateTime) -> i64 {
    let into_day = local.num_seconds_from_midnight() as i64 * 1000 + (local.nanosecond() / 1_000_000) as i64;
    1440 * MINUTE_MS - into_day
}

/// Does `limit` apply on this local day?
pub fn limit_applies(limit: &UsageLimit, local: &NaiveDateTime) -> bool {
    limit.days.contains(&clock(local).1)
}

/// Seconds of `limit` used today.
pub fn limit_used(state: &State, limit_id: &str, local: &NaiveDateTime) -> u64 {
    state
        .usage
        .get(&date_key(local))
        .and_then(|d| d.get(limit_id))
        .copied()
        .unwrap_or(0)
}

/// Is the limit used up for today?
pub fn limit_exhausted(state: &State, limit: &UsageLimit, local: &NaiveDateTime) -> bool {
    limit_applies(limit, local) && limit_used(state, &limit.id, local) >= limit.minutes as u64 * 60
}

/// Every reason a list is enforced at this moment.
pub fn active_blocks(state: &State, now_ms: i64, local: &NaiveDateTime) -> Vec<ActiveBlock> {
    let mut out = Vec::new();
    for s in &state.sessions {
        if s.started_at <= now_ms && now_ms < s.ends_at {
            out.push(ActiveBlock {
                list_id: s.list_id.clone(),
                source: Source::Session,
                ref_id: s.id.clone(),
                ends_at: s.ends_at,
                locked: s.lock != LockMode::None,
                password: s.lock == LockMode::Password,
            });
        }
    }
    for p in &state.permanent {
        out.push(ActiveBlock {
            list_id: p.list_id.clone(),
            source: Source::Permanent,
            ref_id: p.id.clone(),
            ends_at: PERMANENT_END,
            locked: p.lock != LockMode::None,
            password: p.lock == LockMode::Password,
        });
    }
    for sch in &state.schedules {
        if let Some(left) = schedule_remaining_ms(sch, local) {
            out.push(ActiveBlock {
                list_id: sch.list_id.clone(),
                source: Source::Schedule,
                ref_id: sch.id.clone(),
                ends_at: now_ms + left,
                locked: sch.locked,
                password: sch.locked && sch.password,
            });
        }
    }
    if let Some(p) = &state.pomodoro {
        if p.phase == PomodoroPhase::Focus && p.paused_remaining.is_none() {
            if let Some(list_id) = &p.config.list_id {
                out.push(ActiveBlock {
                    list_id: list_id.clone(),
                    source: Source::Pomodoro,
                    ref_id: "pomodoro".into(),
                    ends_at: p.phase_ends_at,
                    locked: p.config.locked,
                    password: p.config.locked && p.config.password,
                });
            }
        }
    }
    for l in &state.limits {
        if limit_exhausted(state, l, local) {
            out.push(ActiveBlock {
                list_id: l.list_id.clone(),
                source: Source::Limit,
                ref_id: l.id.clone(),
                ends_at: now_ms + ms_until_midnight(local),
                locked: l.locked,
                password: l.locked && l.password,
            });
        }
    }
    // Drop blocks referencing deleted lists, and those ended early.
    out.retain(|b| state.list(&b.list_id).is_some() && !is_skipped(state, &b.ref_id, now_ms));
    out
}

fn is_skipped(state: &State, ref_id: &str, now_ms: i64) -> bool {
    state.skips.iter().any(|s| s.ref_id == ref_id && now_ms < s.until)
}

/// Ends a running block early: removes a quick block, stops the focus timer,
/// or skips the current run of a schedule or a used-up limit. Doesn't check
/// locks; callers do (the service checks the password).
pub fn end_block(state: &mut State, ref_id: &str, now_ms: i64, local: &NaiveDateTime) -> Result<(), String> {
    let block = active_blocks(state, now_ms, local)
        .into_iter()
        .find(|b| b.ref_id == ref_id)
        .ok_or("This block isn't running.")?;
    match block.source {
        Source::Session => state.sessions.retain(|s| s.id != ref_id),
        Source::Permanent => state.permanent.retain(|p| p.id != ref_id),
        Source::Pomodoro => state.pomodoro = None,
        Source::Schedule | Source::Limit => {
            state.skips.retain(|s| s.until > now_ms);
            state.skips.push(Skip { ref_id: ref_id.to_string(), until: block.ends_at });
        }
    }
    Ok(())
}

/// Union of every domain and executable that must be blocked.
pub fn enforced_targets(state: &State, blocks: &[ActiveBlock]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut sites = BTreeSet::new();
    let mut apps = BTreeSet::new();
    let ids: BTreeSet<&str> = blocks.iter().map(|b| b.list_id.as_str()).collect();
    for list in state.lists.iter().filter(|l| ids.contains(l.id.as_str())) {
        let (list_sites, list_apps) = list_items(state, list);
        // Allowlist items are *allowed*, not blocked.
        if list.mode == ListMode::Block {
            sites.extend(list_sites);
        }
        if list.app_mode == ListMode::Block {
            apps.extend(list_apps);
        }
    }
    apps.retain(|a| !is_protected_exe(a));
    (sites, apps)
}

/// A list's own items plus those of its categories (normalised).
pub fn list_items(state: &State, list: &BlockList) -> (BTreeSet<String>, BTreeSet<String>) {
    let cats = list.categories.iter().filter_map(|id| state.category(id));
    let mut sites: BTreeSet<String> = list
        .sites
        .iter()
        .chain(cats.clone().flat_map(|c| &c.sites))
        .filter_map(|s| crate::hosts::normalize_site(s))
        .collect();
    // Community lists are normalised when they're loaded.
    for id in &list.categories {
        if let Some(extra) = state.source_sites.get(id) {
            sites.extend(extra.iter().cloned());
        }
    }
    // Exceptions: a domain leaves out the whole site, a path just that part.
    for e in list.except_sites.iter().filter_map(|e| crate::hosts::normalize_site(e)) {
        if crate::hosts::is_path_site(&e) {
            sites.retain(|s| s != &e && !s.starts_with(&format!("{e}/")));
        } else {
            sites.retain(|s| {
                let d = crate::hosts::site_domain(s);
                d != e && !d.ends_with(&format!(".{e}"))
            });
        }
    }
    let mut apps: BTreeSet<String> = list.apps.iter().chain(cats.flat_map(|c| &c.apps)).map(|a| normalize_exe(&a.exe)).collect();
    apps.retain(|a| !list.except_apps.iter().any(|e| exe_matches(&e.exe, a)));
    (sites, apps)
}

/// Does a set of site entries block the whole domain a path belongs to?
fn covers_domain(sites: &BTreeSet<String>, path: &str) -> bool {
    let d = crate::hosts::site_domain(path);
    sites
        .iter()
        .any(|s| !crate::hosts::is_path_site(s) && (d == s || d.ends_with(&format!(".{s}"))))
}

/// A list's path exceptions that open up part of a site it blocks
/// (`reddit.com/r/rust` while `reddit.com` is blocked).
pub fn list_excepted_paths(state: &State, list: &BlockList) -> BTreeSet<String> {
    if list.mode != ListMode::Block {
        return BTreeSet::new();
    }
    let (sites, _) = list_items(state, list);
    list.except_sites
        .iter()
        .filter_map(|e| crate::hosts::normalize_site(e))
        .filter(|e| crate::hosts::is_path_site(e) && covers_domain(&sites, e))
        .collect()
}

/// Paths that stay reachable although their site is blocked: excepted by
/// every active list that blocks their site (one list's exception doesn't
/// override another list that blocks the whole site).
pub fn excepted_paths(state: &State, blocks: &[ActiveBlock]) -> BTreeSet<String> {
    let ids: BTreeSet<&str> = blocks.iter().map(|b| b.list_id.as_str()).collect();
    let active: Vec<(BTreeSet<String>, BTreeSet<String>)> = state
        .lists
        .iter()
        .filter(|l| ids.contains(l.id.as_str()) && l.mode == ListMode::Block)
        .map(|l| (list_items(state, l).0, list_excepted_paths(state, l)))
        .collect();
    let candidates: BTreeSet<&String> = active.iter().flat_map(|(_, ex)| ex).collect();
    candidates
        .into_iter()
        .filter(|p| active.iter().all(|(sites, ex)| !covers_domain(sites, p) || ex.contains(*p)))
        .cloned()
        .collect()
}

/// If an allowlist is active: the only sites browsers may open (union of all
/// active allowlists). `None` when no allowlist is active.
pub fn allowed_sites(state: &State, blocks: &[ActiveBlock]) -> Option<BTreeSet<String>> {
    let ids: BTreeSet<&str> = blocks.iter().map(|b| b.list_id.as_str()).collect();
    let mut allowed: Option<BTreeSet<String>> = None;
    for list in state.lists.iter().filter(|l| ids.contains(l.id.as_str()) && l.mode == ListMode::Allow) {
        // A path in an allowlist allows its whole website.
        let sites = list_items(state, list).0;
        allowed
            .get_or_insert_with(BTreeSet::new)
            .extend(sites.iter().map(|s| crate::hosts::site_domain(s).to_string()));
    }
    allowed
}

/// Do the active blocks use anything only the browser extension can enforce
/// (parts of sites, YouTube channels, website allowlists, exceptions for
/// parts of a site)?
pub fn needs_extension(state: &State, blocks: &[ActiveBlock]) -> bool {
    let (sites, _) = enforced_targets(state, blocks);
    sites.iter().any(|s| crate::hosts::is_path_site(s))
        || youtube_channels(state, blocks).is_some()
        || allowed_sites(state, blocks).is_some()
        || !excepted_paths(state, blocks).is_empty()
}

/// Super strict mode is in force: the setting is on and some block runs.
pub fn super_strict(state: &State, blocks: &[ActiveBlock]) -> bool {
    state.settings.super_strict && !blocks.is_empty()
}

/// Strict fallback without the extension: whole domains the hosts file
/// blocks instead (the domain of each blocked part of a site, and YouTube
/// while only some channels are allowed). Website allowlists have no hosts
/// equivalent.
pub fn strict_fallback_domains(state: &State, blocks: &[ActiveBlock]) -> BTreeSet<String> {
    let (sites, _) = enforced_targets(state, blocks);
    let mut out: BTreeSet<String> = sites
        .iter()
        .filter(|s| crate::hosts::is_path_site(s))
        .map(|s| crate::hosts::site_domain(s).to_string())
        .collect();
    if youtube_channels(state, blocks).is_some() {
        out.extend(["youtube.com", "youtu.be", "youtube-nocookie.com"].map(String::from));
    }
    out
}

/// If an app allowlist is active: the only programs that may be used
/// (normalised exe names, union of all active app allowlists; protected
/// Windows programs are always allowed on top). `None` = no app allowlist.
pub fn allowed_apps(state: &State, blocks: &[ActiveBlock]) -> Option<BTreeSet<String>> {
    let ids: BTreeSet<&str> = blocks.iter().map(|b| b.list_id.as_str()).collect();
    let mut allowed: Option<BTreeSet<String>> = None;
    for list in state.lists.iter().filter(|l| ids.contains(l.id.as_str()) && l.app_mode == ListMode::Allow) {
        allowed.get_or_insert_with(BTreeSet::new).extend(list_items(state, list).1);
    }
    allowed
}

/// May `exe` be used while `allowed` (from [`allowed_apps`]) is in force?
pub fn app_allowed(allowed: &BTreeSet<String>, exe: &str) -> bool {
    is_protected_exe(exe) || allowed.iter().any(|a| exe_matches(exe, a))
}

/// Does this list restrict YouTube to some channels (picked ones and/or the
/// user's subscriptions)?
pub fn restricts_youtube(list: &BlockList) -> bool {
    !list.youtube_channels.is_empty() || list.youtube_subscriptions
}

/// If an active list restricts YouTube to chosen channels: the channels
/// whose videos may play (union of all such lists). `None` = no restriction.
/// The set can be empty when the only allowed channels are subscriptions
/// (see [`youtube_subscriptions`]).
pub fn youtube_channels(state: &State, blocks: &[ActiveBlock]) -> Option<BTreeSet<String>> {
    let ids: BTreeSet<&str> = blocks.iter().map(|b| b.list_id.as_str()).collect();
    let mut out: Option<BTreeSet<String>> = None;
    for list in state.lists.iter().filter(|l| ids.contains(l.id.as_str()) && restricts_youtube(l)) {
        out.get_or_insert_with(BTreeSet::new).extend(list.youtube_channels.iter().cloned());
    }
    out
}

/// While YouTube is restricted: do subscribed channels count as allowed, and
/// is that locked (then new subscriptions mustn't open new channels)?
/// Like picked channels, subscriptions count if any active list allows them.
pub fn youtube_subscriptions(state: &State, blocks: &[ActiveBlock]) -> (bool, bool) {
    let with_subs: Vec<&BlockList> = state
        .lists
        .iter()
        .filter(|l| l.youtube_subscriptions && blocks.iter().any(|b| b.list_id == l.id))
        .collect();
    let locked = blocks.iter().any(|b| b.locked && with_subs.iter().any(|l| l.id == b.list_id));
    (!with_subs.is_empty(), locked)
}

fn strictness(l: LockMode) -> u8 {
    match l {
        LockMode::None => 0,
        LockMode::Text => 1,
        LockMode::Password => 2,
        LockMode::Timer => 3,
    }
}

/// Starting a block on a list that already has a running quick block merges
/// into it: the later end time and the stricter lock win. Returns the id of
/// the session that now covers the request.
pub fn start_or_merge_session(state: &mut State, list_id: &str, now_ms: i64, ends_at: i64, lock: LockMode, new_id: String) -> String {
    if let Some(s) = state
        .sessions
        .iter_mut()
        .find(|s| s.list_id == list_id && s.started_at <= now_ms && now_ms < s.ends_at)
    {
        s.ends_at = s.ends_at.max(ends_at);
        if strictness(lock) > strictness(s.lock) {
            s.lock = lock;
        }
        return s.id.clone();
    }
    state.sessions.push(Session {
        id: new_id.clone(),
        list_id: list_id.into(),
        started_at: now_ms,
        ends_at,
        lock,
    });
    new_id
}

/// If a category is used by a locked, running block, returns when that lock ends.
pub fn category_locked_until(state: &State, category_id: &str, now_ms: i64, local: &NaiveDateTime) -> Option<i64> {
    state
        .lists
        .iter()
        .filter(|l| l.categories.iter().any(|c| c == category_id))
        .filter_map(|l| list_locked_until(state, &l.id, now_ms, local))
        .max()
}

/// While a category is locked you may add to it but never remove from it.
pub fn category_is_superset(old: &Category, new: &Category) -> bool {
    let sites_ok = old.sites.iter().all(|s| new.sites.iter().any(|n| n.eq_ignore_ascii_case(s)));
    let apps_ok = old
        .apps
        .iter()
        .all(|a| new.apps.iter().any(|n| exe_matches(&n.exe, &normalize_exe(&a.exe))));
    sites_ok && apps_ok
}

/// Programs OpenBlocker never closes, whatever a list says: Windows itself
/// (closing these can crash or lock up the PC), the shell that shows the tray
/// icon, WebView2 (which draws OpenBlocker's window), and OpenBlocker. This
/// keeps the app, and with it the emergency reset, reachable in any
/// configuration. Task Manager is deliberately not here (frozen PCs block it).
pub const PROTECTED_EXES: &[&str] = &[
    "openblocker.exe",
    "msedgewebview2.exe",
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "dwm.exe",
    "explorer.exe",
    "sihost.exe",
    "fontdrvhost.exe",
    "ctfmon.exe",
    "conhost.exe",
    "taskhostw.exe",
    "runtimebroker.exe",
    "dllhost.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "logonui.exe",
    "lockapp.exe",
    "userinit.exe",
    "consent.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "searchhost.exe",
    "textinputhost.exe",
    "securityhealthservice.exe",
    "msmpeng.exe",
    "smartscreen.exe",
    "werfault.exe",
];

/// Is this executable on the [`PROTECTED_EXES`] list?
pub fn is_protected_exe(exe: &str) -> bool {
    PROTECTED_EXES.iter().any(|p| exe_matches(exe, p))
}

/// Lowercase executable name without directory, always ending in `.exe` on Windows-style names.
pub fn normalize_exe(exe: &str) -> String {
    let base = exe.rsplit(['\\', '/']).next().unwrap_or(exe).trim().to_lowercase();
    base
}

/// Does a running process name match a blocked executable?
pub fn exe_matches(process_name: &str, blocked: &str) -> bool {
    let p = normalize_exe(process_name);
    let strip = |s: &str| s.strip_suffix(".exe").map(str::to_string).unwrap_or_else(|| s.to_string());
    strip(&p) == strip(blocked)
}

/// If the list is protected by a locked block, returns when that lock ends.
pub fn list_locked_until(state: &State, list_id: &str, now_ms: i64, local: &NaiveDateTime) -> Option<i64> {
    active_blocks(state, now_ms, local)
        .into_iter()
        .filter(|b| b.list_id == list_id && b.locked)
        .map(|b| b.ends_at)
        .max()
}

/// While a list is locked you may add things to it but never remove them.
pub fn is_strict_superset(old: &BlockList, new: &BlockList) -> bool {
    let sites_ok = old.sites.iter().all(|s| new.sites.iter().any(|n| n.eq_ignore_ascii_case(s)));
    let apps_ok = old
        .apps
        .iter()
        .all(|a| new.apps.iter().any(|n| exe_matches(&n.exe, &normalize_exe(&a.exe))));
    // Removing a whole category from a locked list is also a removal.
    let cats_ok = old.categories.iter().all(|c| new.categories.contains(c));
    sites_ok && apps_ok && cats_ok
}

fn phase_minutes(cfg: &PomodoroConfig, phase: PomodoroPhase) -> i64 {
    (match phase {
        PomodoroPhase::Focus => cfg.focus_min,
        PomodoroPhase::Break => cfg.break_min,
        PomodoroPhase::LongBreak => cfg.long_break_min,
    }) as i64
        * MINUTE_MS
}

pub fn new_pomodoro(cfg: PomodoroConfig, now_ms: i64) -> Pomodoro {
    Pomodoro {
        phase_ends_at: now_ms + phase_minutes(&cfg, PomodoroPhase::Focus),
        config: cfg,
        phase: PomodoroPhase::Focus,
        round: 1,
        phase_started_at: now_ms,
        paused_remaining: None,
    }
}

/// Moves a pomodoro to its next phase. Returns events and the new value (None = finished).
pub fn advance_pomodoro(p: &Pomodoro, now_ms: i64) -> (Option<Pomodoro>, Vec<Event>) {
    let mut events = Vec::new();
    let mut next = p.clone();
    match p.phase {
        PomodoroPhase::Focus => {
            events.push(Event::PomodoroFocusCompleted);
            if p.config.total_rounds.is_some_and(|t| p.round >= t) {
                events.push(Event::PomodoroFinished);
                return (None, events);
            }
            let rounds = p.config.rounds.max(1);
            next.phase = if p.round.is_multiple_of(rounds) {
                PomodoroPhase::LongBreak
            } else {
                PomodoroPhase::Break
            };
        }
        PomodoroPhase::Break | PomodoroPhase::LongBreak => {
            next.phase = PomodoroPhase::Focus;
            next.round += 1;
        }
    }
    next.phase_started_at = now_ms;
    next.phase_ends_at = now_ms + phase_minutes(&next.config, next.phase);
    next.paused_remaining = None;
    events.push(Event::PomodoroPhase {
        phase: next.phase,
        round: next.round,
    });
    (Some(next), events)
}

/// Expire finished sessions/freezes and advance the pomodoro. Returns what happened.
pub fn tick(state: &mut State, now_ms: i64) -> Vec<Event> {
    let mut events = Vec::new();
    state.sessions.retain(|s| {
        let alive = s.ends_at > now_ms;
        if !alive {
            events.push(Event::SessionEnded {
                list_id: s.list_id.clone(),
            });
        }
        alive
    });
    if let Some(p) = state.pomodoro.clone() {
        if p.paused_remaining.is_none() && now_ms >= p.phase_ends_at {
            let (next, ev) = advance_pomodoro(&p, now_ms);
            state.pomodoro = next;
            events.extend(ev);
        }
    }
    if state.freeze.as_ref().is_some_and(|f| f.ends_at <= now_ms) {
        state.freeze = None;
        events.push(Event::FreezeEnded);
    }
    state.skips.retain(|s| s.until > now_ms);
    events
}

/// What the user is doing right now, for usage limits.
#[derive(Clone, Debug, Default)]
pub struct Activity {
    /// Executable of the foreground window, e.g. "steam.exe".
    pub exe: Option<String>,
    /// URL of the active tab, when the foreground window is a browser with the extension.
    pub url: Option<String>,
}

/// Does `list` cover what the user is doing?
fn activity_matches(state: &State, list: &BlockList, activity: &Activity) -> bool {
    let (sites, apps) = list_items(state, list);
    let site_hit = activity
        .url
        .as_deref()
        .is_some_and(|url| sites.iter().any(|s| crate::hosts::url_matches(url, s)));
    // A browser showing an allowed site doesn't count as using the browser app.
    let app_hit = activity.url.is_none() && activity.exe.as_deref().is_some_and(|exe| apps.iter().any(|a| exe_matches(exe, a)));
    // Limits only make sense for lists that block things.
    list.mode == ListMode::Block && (site_hit || app_hit)
}

/// Adds `seconds` of usage to every limit that applies today and covers
/// `activity`. Returns ids of limits that were used up by this call.
pub fn add_usage(state: &mut State, local: &NaiveDateTime, seconds: u64, activity: &Activity) -> Vec<String> {
    if seconds == 0 || (activity.exe.is_none() && activity.url.is_none()) {
        return vec![];
    }
    let today = date_key(local);
    let hits: Vec<(String, u64)> = state
        .limits
        .iter()
        .filter(|l| limit_applies(l, local))
        .filter(|l| state.list(&l.list_id).is_some_and(|list| activity_matches(state, list, activity)))
        .map(|l| (l.id.clone(), l.minutes as u64 * 60))
        .collect();
    let mut used_up = vec![];
    let day = state.usage.entry(today.clone()).or_default();
    for (id, allowed) in hits {
        let v = day.entry(id.clone()).or_default();
        let before = *v;
        *v += seconds;
        if before < allowed && *v >= allowed {
            used_up.push(id);
        }
    }
    // Keep two weeks of history.
    while state.usage.len() > 14 {
        let oldest = state.usage.keys().next().cloned().unwrap();
        state.usage.remove(&oldest);
    }
    used_up
}

/// Would replacing `old` by `new` weaken a lock that is running at this
/// moment? Returns a human-readable reason if so. This is the single rule
/// both the app and the background service enforce:
/// * every locked block must keep running at least as long as before,
/// * a locked list may only get stricter (block lists only grow, allowlists
///   only shrink), whether edited directly or through its categories,
/// * a running freeze can't be shortened,
/// * settings that weaken blocking can't be turned off while locked,
/// * today's usage of a locked limit never goes down.
pub fn lock_violation(old: &State, new: &State, now_ms: i64, local: &NaiveDateTime) -> Option<String> {
    const SLACK_MS: i64 = 5_000; // the app and the service tick independently
    let old_blocks = active_blocks(old, now_ms, local);
    let new_blocks = active_blocks(new, now_ms, local);
    let locked: Vec<&ActiveBlock> = old_blocks.iter().filter(|b| b.locked).collect();
    for b in &locked {
        let kept = new_blocks
            .iter()
            .any(|n| n.locked && (b.password || !n.password) && n.list_id == b.list_id && n.ends_at >= b.ends_at - SLACK_MS);
        if !kept {
            return Some("A locked block can't be stopped or shortened.".into());
        }
    }
    let locked_lists: BTreeSet<&str> = locked.iter().map(|b| b.list_id.as_str()).collect();
    for id in locked_lists {
        let (Some(o), Some(n)) = (old.list(id), new.list(id)) else {
            return Some("A locked list can't be deleted.".into());
        };
        if o.mode != n.mode || o.app_mode != n.app_mode {
            return Some(format!("“{}” is locked: its mode can't change.", o.name));
        }
        let (os, oa) = list_items(old, o);
        let (ns, na) = list_items(new, n);
        let apps_ok = match o.app_mode {
            ListMode::Block => oa.iter().all(|a| na.iter().any(|x| exe_matches(x, a))),
            ListMode::Allow => na.iter().all(|a| oa.iter().any(|x| exe_matches(x, a))),
        };
        let sites_ok = match o.mode {
            ListMode::Block => os.is_subset(&ns),
            ListMode::Allow => ns.is_subset(&os),
        };
        // A channel restriction may get stricter (fewer channels, no longer
        // allowing subscriptions), never looser.
        let channels_ok = !restricts_youtube(o)
            || (restricts_youtube(n)
                && n.youtube_channels.iter().all(|c| o.youtube_channels.contains(c))
                && (!n.youtube_subscriptions || o.youtube_subscriptions));
        if !channels_ok {
            return Some(format!("“{}” is locked. You can remove YouTube channels, but not add any.", o.name));
        }
        if !list_excepted_paths(new, n).is_subset(&list_excepted_paths(old, o)) {
            return Some(format!("“{}” is locked: no new exceptions until it ends.", o.name));
        }
        if !apps_ok && o.app_mode == ListMode::Allow {
            return Some(format!("“{}” is locked: you can remove allowed apps, but not add any.", o.name));
        }
        if !apps_ok || !sites_ok {
            return Some(match o.mode {
                ListMode::Block => format!("“{}” is locked. You can add items, but not remove them.", o.name),
                ListMode::Allow => format!("“{}” is a locked allowlist. You can remove sites, but not add them.", o.name),
            });
        }
    }
    if let Some(f) = &old.freeze {
        if f.ends_at > now_ms && new.freeze.as_ref().is_none_or(|n| n.ends_at < f.ends_at) {
            return Some("The freeze can't be shortened.".into());
        }
        if old.settings.freeze_blocks_task_manager && !new.settings.freeze_blocks_task_manager {
            return Some("This setting can't be turned off while frozen.".into());
        }
    }
    if !locked.is_empty() {
        let (o, n) = (&old.settings, &new.settings);
        let private_rank = |p: PrivateWindows| match p {
            PrivateWindows::Off => 0,
            PrivateWindows::Default => 1,
            PrivateWindows::On => 2,
        };
        if (o.block_subdomains && !n.block_subdomains)
            || (o.extension_fallback == ExtensionFallback::Strict && n.extension_fallback == ExtensionFallback::Lenient)
            || private_rank(n.private_windows) < private_rank(o.private_windows)
            || (o.hide_short_video_feeds && !n.hide_short_video_feeds)
            || (o.require_extension && !n.require_extension)
            || (o.super_strict && !n.super_strict)
            || n.unlock_text_length < o.unlock_text_length
        {
            return Some("Settings that loosen blocking can't be changed while a locked block is running.".into());
        }
    }
    if old.password.is_some() && new.password != old.password {
        return Some("The password can only be changed with the current password.".into());
    }
    let today = date_key(local);
    for l in old.limits.iter().filter(|l| l.locked) {
        let before = old.usage.get(&today).and_then(|d| d.get(&l.id)).copied().unwrap_or(0);
        let after = new.usage.get(&today).and_then(|d| d.get(&l.id)).copied().unwrap_or(0);
        if after < before && new.limits.iter().any(|x| x.id == l.id) {
            return Some("Usage of a locked limit can't be reset.".into());
        }
    }
    None
}

/// Data that can be exported, imported and (later) synced between devices.
/// Running blocks, the timer and statistics are deliberately not included.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    /// Always "OpenBlocker"; used to reject unrelated JSON files.
    pub app: String,
    pub format: u32,
    pub exported_at: i64,
    pub categories: Vec<Category>,
    pub lists: Vec<BlockList>,
    pub schedules: Vec<Schedule>,
    pub settings: Settings,
    #[serde(default)]
    pub limits: Vec<UsageLimit>,
}

pub const BACKUP_APP: &str = "OpenBlocker";
pub const BACKUP_FORMAT: u32 = 1;

pub fn backup(state: &State, now_ms: i64) -> Backup {
    Backup {
        app: BACKUP_APP.into(),
        format: BACKUP_FORMAT,
        exported_at: now_ms,
        categories: state.categories.clone(),
        lists: state.lists.clone(),
        schedules: state.schedules.clone(),
        settings: state.settings.clone(),
        limits: state.limits.clone(),
    }
}

/// Replaces lists, categories, schedules and settings with those of `b`.
/// Refused while any locked block runs, so an import can never be used to
/// weaken a lock. Quick blocks and the focus timer keep running if their list
/// still exists.
pub fn restore(state: &mut State, b: Backup, now_ms: i64, local: &NaiveDateTime) -> Result<(), String> {
    if b.app != BACKUP_APP {
        return Err("This isn't an OpenBlocker settings file.".into());
    }
    if b.format > BACKUP_FORMAT {
        return Err("This file was made by a newer version of OpenBlocker. Please update first.".into());
    }
    if active_blocks(state, now_ms, local).iter().any(|a| a.locked) {
        return Err("A locked block is running. You can import settings once it ends.".into());
    }
    let mut ids = BTreeSet::new();
    if b.lists.iter().any(|l| l.id.is_empty() || !ids.insert(l.id.as_str())) {
        return Err("The file contains invalid block lists.".into());
    }
    let mut ids = BTreeSet::new();
    if b.categories.iter().any(|c| c.id.is_empty() || !ids.insert(c.id.as_str())) {
        return Err("The file contains invalid categories.".into());
    }
    state.categories = b.categories;
    state.lists = b.lists;
    let cats: BTreeSet<String> = state.categories.iter().map(|c| c.id.clone()).collect();
    for l in &mut state.lists {
        l.categories.retain(|c| cats.contains(c));
    }
    let lists: BTreeSet<String> = state.lists.iter().map(|l| l.id.clone()).collect();
    state.schedules = b
        .schedules
        .into_iter()
        .filter(|s| lists.contains(&s.list_id) && !s.days.is_empty() && s.start < 1440 && s.end < 1440)
        .collect();
    state.limits = b.limits.into_iter().filter(|l| lists.contains(&l.list_id) && !l.days.is_empty()).collect();
    state.sessions.retain(|s| lists.contains(&s.list_id));
    if let Some(p) = state.pomodoro.as_mut() {
        if p.config.list_id.as_ref().is_some_and(|id| !lists.contains(id)) {
            p.config.list_id = None;
        }
    }
    state.settings = b.settings;
    Ok(())
}

/// Emergency reset: back to factory state, ending every block, schedule,
/// focus session and freeze. Statistics are kept.
pub fn factory_reset(state: &State) -> State {
    State {
        stats: state.stats.clone(),
        ..State::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// 2026-11-09 is a Monday.
    fn at(day: u32, h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, day).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    fn sched(days: &[u8], start: u16, end: u16) -> Schedule {
        Schedule {
            id: "s".into(),
            list_id: "social".into(),
            days: days.to_vec(),
            start,
            end,
            locked: false,
            password: false,
            label: None,
        }
    }

    #[test]
    fn daytime_schedule() {
        let s = sched(&[0], 9 * 60, 17 * 60);
        assert_eq!(schedule_remaining_ms(&s, &at(9, 8, 59)), None);
        assert_eq!(schedule_remaining_ms(&s, &at(9, 9, 0)), Some(8 * 60 * MINUTE_MS));
        assert_eq!(schedule_remaining_ms(&s, &at(9, 16, 59)), Some(MINUTE_MS));
        assert_eq!(schedule_remaining_ms(&s, &at(9, 17, 0)), None);
        // Tuesday not included.
        assert_eq!(schedule_remaining_ms(&s, &at(10, 10, 0)), None);
    }

    #[test]
    fn overnight_schedule() {
        // Monday 22:00 → Tuesday 06:00
        let s = sched(&[0], 22 * 60, 6 * 60);
        assert_eq!(schedule_remaining_ms(&s, &at(9, 23, 0)), Some(7 * 60 * MINUTE_MS));
        assert_eq!(schedule_remaining_ms(&s, &at(10, 5, 0)), Some(60 * MINUTE_MS));
        assert_eq!(schedule_remaining_ms(&s, &at(10, 6, 0)), None);
        // Monday early morning belongs to Sunday's slot, which is not set.
        assert_eq!(schedule_remaining_ms(&s, &at(9, 5, 0)), None);
    }

    #[test]
    fn whole_day_schedule() {
        let s = sched(&[6], 0, 0);
        assert_eq!(schedule_remaining_ms(&s, &at(15, 12, 0)), Some(12 * 60 * MINUTE_MS));
        assert_eq!(schedule_remaining_ms(&s, &at(14, 12, 0)), None);
    }

    #[test]
    fn locked_lists_only_grow() {
        let mut old = State::default().lists[0].clone();
        old.sites = vec!["reddit.com".into(), "x.com".into()];
        let mut grown = old.clone();
        grown.sites.push("pinterest.com".into());
        assert!(is_strict_superset(&old, &grown));
        let mut shrunk = old.clone();
        shrunk.sites.pop();
        assert!(!is_strict_superset(&old, &shrunk));
    }

    #[test]
    fn categories_are_enforced_and_locked() {
        let mut st = State::default();
        assert!(st.categories.iter().any(|c| c.id == "adult" && !c.sites.is_empty()));
        st.sessions.push(Session {
            id: "a".into(),
            list_id: "social".into(),
            started_at: 0,
            ends_at: 1000,
            lock: LockMode::Timer,
        });
        let local = at(9, 12, 0);
        let blocks = active_blocks(&st, 500, &local);
        let (sites, _) = enforced_targets(&st, &blocks);
        assert!(sites.contains("instagram.com"));
        // Editing the category changes what the list blocks.
        st.categories.iter_mut().find(|c| c.id == "social").unwrap().sites.push("example.org".into());
        let (sites, _) = enforced_targets(&st, &blocks);
        assert!(sites.contains("example.org"));
        // The category is locked because a locked list uses it.
        assert_eq!(category_locked_until(&st, "social", 500, &local), Some(1000));
        assert_eq!(category_locked_until(&st, "adult", 500, &local), None);
        // Dropping the category from a locked list counts as removal.
        let old = st.lists[0].clone();
        let mut new = old.clone();
        new.categories.clear();
        assert!(!is_strict_superset(&old, &new));
    }

    #[test]
    fn sessions_on_same_list_merge() {
        let mut st = State::default();
        st.sessions.clear();
        let a = start_or_merge_session(&mut st, "social", 0, 1000, LockMode::None, "a".into());
        let b = start_or_merge_session(&mut st, "social", 10, 500, LockMode::Timer, "b".into());
        assert_eq!(a, b);
        assert_eq!(st.sessions.len(), 1);
        assert_eq!(st.sessions[0].ends_at, 1000); // later end wins
        assert_eq!(st.sessions[0].lock, LockMode::Timer); // stricter lock wins
        start_or_merge_session(&mut st, "video", 10, 500, LockMode::None, "c".into());
        assert_eq!(st.sessions.len(), 2);
    }

    #[test]
    fn allowlists_allow_instead_of_block() {
        let mut st = State::default();
        st.lists.push(BlockList {
            id: "work".into(),
            name: "Work only".into(),
            color: "#fff".into(),
            icon: "x".into(),
            sites: vec!["github.com".into()],
            apps: vec![AppEntry { name: "Steam".into(), exe: "steam.exe".into(), path: None }],
            categories: vec![],
            mode: ListMode::Allow,
            youtube_channels: vec![],
            youtube_subscriptions: false,
            except_sites: vec![],
            except_apps: vec![],
            app_mode: ListMode::Block,
        });
        let local = at(9, 12, 0);
        assert_eq!(allowed_sites(&st, &active_blocks(&st, 0, &local)), None);
        start_or_merge_session(&mut st, "work", 0, 1000, LockMode::None, "w".into());
        let blocks = active_blocks(&st, 500, &local);
        let (sites, apps) = enforced_targets(&st, &blocks);
        assert!(!sites.contains("github.com"));
        assert!(apps.contains("steam.exe"));
        assert_eq!(allowed_sites(&st, &blocks), Some(["github.com".to_string()].into()));
    }

    #[test]
    fn exe_matching() {
        assert!(exe_matches("Steam.exe", "steam.exe"));
        assert!(exe_matches("C:\\Games\\Steam\\steam.exe", "steam.exe"));
        assert!(exe_matches("discord", "discord.exe"));
        assert!(!exe_matches("steamwebhelper.exe", "steam.exe"));
    }

    #[test]
    fn pomodoro_cycle() {
        let cfg = PomodoroConfig {
            rounds: 2,
            total_rounds: Some(3),
            ..Default::default()
        };
        let mut p = new_pomodoro(cfg, 0);
        let mut phases = vec![];
        for _ in 0..10 {
            let (next, ev) = advance_pomodoro(&p, p.phase_ends_at);
            match next {
                Some(n) => {
                    phases.push(n.phase);
                    p = n;
                }
                None => {
                    assert!(ev.contains(&Event::PomodoroFinished));
                    break;
                }
            }
        }
        use PomodoroPhase::*;
        assert_eq!(phases, vec![Break, Focus, LongBreak, Focus]);
    }

    #[test]
    fn tick_expires_sessions() {
        let mut st = State::default();
        st.sessions.push(Session {
            id: "a".into(),
            list_id: "social".into(),
            started_at: 0,
            ends_at: 1000,
            lock: LockMode::Timer,
        });
        let local = at(9, 12, 0);
        assert_eq!(active_blocks(&st, 500, &local).len(), 1);
        assert_eq!(list_locked_until(&st, "social", 500, &local), Some(1000));
        let ev = tick(&mut st, 1000);
        assert_eq!(ev, vec![Event::SessionEnded { list_id: "social".into() }]);
        assert!(st.sessions.is_empty());
    }

    #[test]
    fn path_sites_are_kept_and_allowlists_use_their_domain() {
        let mut state = State::default();
        state.lists[0].sites = vec!["https://www.youtube.com/shorts/".into()];
        state.lists[0].categories.clear();
        let (sites, _) = list_items(&state, &state.lists[0]);
        assert!(sites.contains("youtube.com/shorts"));
        state.lists[0].mode = ListMode::Allow;
        let blocks = vec![ActiveBlock {
            list_id: state.lists[0].id.clone(),
            source: Source::Session,
            ref_id: "x".into(),
            ends_at: 1,
            locked: false,
            password: false,
        }];
        assert_eq!(allowed_sites(&state, &blocks), Some(["youtube.com".to_string()].into()));
    }

    #[test]
    fn backup_roundtrip_and_lock_protection() {
        let now = 1_000_000;
        let local = at(4, 12, 0);
        let mut state = State::default();
        state.lists.truncate(1);
        let b = backup(&state, now);
        let json = serde_json::to_string(&b).unwrap();

        let mut other = State::default();
        other.sessions.push(Session { id: "s".into(), list_id: "games".into(), started_at: 0, ends_at: now * 2, lock: LockMode::None });
        restore(&mut other, serde_json::from_str(&json).unwrap(), now, &local).unwrap();
        assert_eq!(other.lists, state.lists);
        // Quick blocks of lists that no longer exist are dropped.
        assert!(other.sessions.is_empty());

        // Never while a locked block runs.
        other.sessions.push(Session { id: "l".into(), list_id: state.lists[0].id.clone(), started_at: 0, ends_at: now * 2, lock: LockMode::Timer });
        assert!(restore(&mut other, b.clone(), now, &local).is_err());

        let mut bad = b;
        bad.app = "Something else".into();
        assert!(restore(&mut State::default(), bad, now, &local).is_err());
    }

    #[test]
    fn factory_reset_ends_everything_but_keeps_stats() {
        let mut state = State::default();
        state.schedules.push(sched(&[0, 1, 2, 3, 4, 5, 6], 0, 0));
        state.schedules[0].locked = true;
        state.freeze = Some(Freeze { started_at: 0, ends_at: 10, message: String::new() });
        state.stats.insert("2026-01-01".into(), DayStats { pomodoros: 3, ..Default::default() });
        let fresh = factory_reset(&state);
        assert!(fresh.schedules.is_empty() && fresh.freeze.is_none());
        assert_eq!(fresh.stats["2026-01-01"].pomodoros, 3);
    }

    fn limit(minutes: u32, locked: bool) -> UsageLimit {
        UsageLimit { id: "lim".into(), list_id: "video".into(), minutes, days: (0..7).collect(), locked, password: false }
    }

    #[test]
    fn usage_limits_count_and_block_until_midnight() {
        let local = at(4, 22, 0); // Wednesday 22:00
        let mut state = State::default();
        state.limits.push(limit(1, false));
        let yt = Activity { exe: Some("chrome.exe".into()), url: Some("https://www.youtube.com/watch?v=1".into()) };
        let other = Activity { exe: Some("chrome.exe".into()), url: Some("https://wikipedia.org/".into()) };
        assert!(add_usage(&mut state, &local, 30, &other).is_empty());
        assert_eq!(limit_used(&state, "lim", &local), 0);
        assert!(add_usage(&mut state, &local, 30, &yt).is_empty());
        assert!(active_blocks(&state, 0, &local).is_empty());
        assert_eq!(add_usage(&mut state, &local, 30, &yt), vec!["lim".to_string()]);
        let blocks = active_blocks(&state, 0, &local);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, Source::Limit);
        assert_eq!(blocks[0].ends_at, 2 * 60 * MINUTE_MS);
        // A new day starts fresh.
        assert!(active_blocks(&state, 0, &at(5, 0, 1)).is_empty());
        // Apps count too (a browser only through its URL).
        let mut state = State::default();
        state.limits.push(UsageLimit { list_id: "games".into(), ..limit(1, false) });
        add_usage(&mut state, &local, 10, &Activity { exe: Some("Steam.exe".into()), url: None });
        assert_eq!(limit_used(&state, "lim", &local), 10);
    }

    #[test]
    fn lock_violation_rules() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        old.sessions.push(Session { id: "s".into(), list_id: "social".into(), started_at: 0, ends_at: now + 60 * MINUTE_MS, lock: LockMode::Timer });
        assert!(lock_violation(&old, &old, now, &local).is_none());

        let mut new = old.clone();
        new.sessions.clear();
        assert!(lock_violation(&old, &new, now, &local).is_some(), "stopping");

        let mut new = old.clone();
        new.sessions[0].ends_at -= 10 * MINUTE_MS;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "shortening");

        let mut new = old.clone();
        new.categories.iter_mut().find(|c| c.id == "social").unwrap().sites.pop();
        assert!(lock_violation(&old, &new, now, &local).is_some(), "shrinking a category of a locked list");

        let mut new = old.clone();
        new.lists[0].sites.push("example.com".into());
        new.lists[1].sites.clear(); // unlocked list: anything goes
        assert!(lock_violation(&old, &new, now, &local).is_none(), "growing is fine");

        // Allowlists: adding allowed sites weakens, removing strengthens.
        let mut old_allow = old.clone();
        old_allow.lists[0].mode = ListMode::Allow;
        let mut new = old_allow.clone();
        new.lists[0].sites.push("example.com".into());
        assert!(lock_violation(&old_allow, &new, now, &local).is_some(), "allowing more");
        let mut new = old_allow.clone();
        new.lists[0].mode = ListMode::Block;
        assert!(lock_violation(&old_allow, &new, now, &local).is_some(), "flipping mode");

        let mut new = old.clone();
        new.settings.block_subdomains = false;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "loosening settings");

        // Once the lock is over, everything is allowed again.
        let later = now + 61 * MINUTE_MS;
        let mut new = old.clone();
        new.sessions.clear();
        new.settings.block_subdomains = false;
        assert!(lock_violation(&old, &new, later, &local).is_none());

        // Locked, used-up limits can't be raised or have their usage reset.
        let mut old = State::default();
        old.limits.push(limit(1, true));
        old.usage.insert(date_key(&local), [("lim".to_string(), 60u64)].into());
        let mut new = old.clone();
        new.limits[0].minutes = 5;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "raising a used-up locked limit");
        let mut new = old.clone();
        new.usage.clear();
        assert!(lock_violation(&old, &new, now, &local).is_some(), "resetting usage");
    }

    #[test]
    fn community_lists_are_included() {
        let mut state = State::default();
        state.source_sites.insert("social".into(), std::sync::Arc::new(["huge-list-domain.com".to_string()].into()));
        let (sites, _) = list_items(&state, &state.lists[0]);
        assert!(sites.contains("huge-list-domain.com"));
    }

    #[test]
    fn youtube_channel_restrictions() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        old.lists[1].youtube_channels = vec!["@a".into(), "@b".into()];
        old.sessions.push(Session { id: "s".into(), list_id: "video".into(), started_at: 0, ends_at: now + 60 * MINUTE_MS, lock: LockMode::Timer });
        let blocks = active_blocks(&old, now, &local);
        assert_eq!(youtube_channels(&old, &blocks), Some(["@a".to_string(), "@b".to_string()].into()));
        let mut new = old.clone();
        new.lists[1].youtube_channels = vec!["@a".into()];
        assert!(lock_violation(&old, &new, now, &local).is_none(), "fewer channels is stricter");
        new.lists[1].youtube_channels.push("@c".into());
        assert!(lock_violation(&old, &new, now, &local).is_some(), "adding a channel");
        new.lists[1].youtube_channels.clear();
        assert!(lock_violation(&old, &new, now, &local).is_some(), "dropping the restriction");
        new.lists[1].youtube_channels = vec!["@a".into()];
        new.lists[1].youtube_subscriptions = true;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "allowing subscriptions loosens");
    }

    #[test]
    fn youtube_subscriptions_only() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        old.lists[1].youtube_subscriptions = true;
        old.sessions.push(Session { id: "s".into(), list_id: "video".into(), started_at: 0, ends_at: now + 60 * MINUTE_MS, lock: LockMode::Timer });
        let blocks = active_blocks(&old, now, &local);
        // A restriction with no picked channels: only subscriptions play.
        assert_eq!(youtube_channels(&old, &blocks), Some(BTreeSet::new()));
        assert_eq!(youtube_subscriptions(&old, &blocks), (true, true));
        assert!(needs_extension(&old, &blocks));
        let mut new = old.clone();
        new.lists[1].youtube_subscriptions = false;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "turning it off drops the restriction");
        new.lists[1].youtube_channels = vec!["@a".into()];
        assert!(lock_violation(&old, &new, now, &local).is_some(), "swapping subscriptions for another channel");
        // Combined with another restricting list: picked channels and
        // subscriptions add up, like channels of several lists do.
        let mut both = old.clone();
        both.lists[0].youtube_channels = vec!["@a".into()];
        both.sessions.push(Session { id: "t".into(), list_id: "social".into(), started_at: 0, ends_at: now + MINUTE_MS, lock: LockMode::None });
        let blocks = active_blocks(&both, now, &local);
        assert_eq!(youtube_channels(&both, &blocks), Some(["@a".to_string()].into()));
        assert_eq!(youtube_subscriptions(&both, &blocks), (true, true));
        // Not active: nothing restricted.
        let later = active_blocks(&old, now + 2 * 60 * MINUTE_MS, &local);
        assert_eq!(youtube_subscriptions(&old, &later), (false, false));
    }

    #[test]
    fn migration_adds_new_builtin_categories_once() {
        let mut old = State::default();
        old.version = 1;
        old.categories.retain(|c| c.id != "shorts");
        old.migrate();
        assert!(old.category("shorts").is_some_and(|c| c.sites.contains(&"youtube.com/shorts".to_string())));
        assert_eq!(old.version, STATE_VERSION);
        // Deleted again by the user: stays deleted.
        old.categories.retain(|c| c.id != "shorts");
        old.migrate();
        assert!(old.category("shorts").is_none());
    }

    #[test]
    fn exceptions_leave_sites_and_apps_out() {
        let mut state = State::default();
        // Social media except Facebook (also covers its subdomains).
        state.lists[0].except_sites = vec!["facebook.com".into()];
        let (sites, _) = list_items(&state, &state.lists[0]);
        assert!(sites.contains("instagram.com") && !sites.contains("facebook.com"));
        // Games except Steam.
        state.lists[2].except_apps = vec![AppEntry { name: "Steam".into(), exe: "steam.exe".into(), path: None }];
        let (_, apps) = list_items(&state, &state.lists[2]);
        assert!(!apps.contains("steam.exe"));
    }

    #[test]
    fn path_exceptions_open_part_of_a_blocked_site() {
        let local = at(4, 12, 0);
        let mut state = State::default();
        state.lists[0].categories.clear();
        state.lists[0].sites = vec!["reddit.com".into()];
        state.lists[0].except_sites = vec!["reddit.com/r/rust".into(), "example.org/x".into()];
        state.sessions.push(Session { id: "a".into(), list_id: "social".into(), started_at: 0, ends_at: 10, lock: LockMode::None });
        let blocks = active_blocks(&state, 0, &local);
        // Only exceptions inside a blocked site count.
        assert_eq!(excepted_paths(&state, &blocks), ["reddit.com/r/rust".to_string()].into());
        // Another active list blocking all of reddit wins.
        state.lists[1].categories.clear();
        state.lists[1].sites = vec!["reddit.com".into()];
        state.sessions.push(Session { id: "b".into(), list_id: "video".into(), started_at: 0, ends_at: 10, lock: LockMode::None });
        let blocks = active_blocks(&state, 0, &local);
        assert!(excepted_paths(&state, &blocks).is_empty());
    }

    #[test]
    fn locked_lists_get_no_new_exceptions() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        old.sessions.push(Session { id: "s".into(), list_id: "social".into(), started_at: 0, ends_at: now + MINUTE_MS, lock: LockMode::Timer });
        let mut new = old.clone();
        new.lists[0].except_sites = vec!["facebook.com".into()];
        assert!(lock_violation(&old, &new, now, &local).is_some());
        let mut new = old.clone();
        new.lists[0].sites.push("reddit.com".into());
        new.lists[0].except_sites = vec!["reddit.com/r/rust".into()];
        assert!(lock_violation(&old, &new, now, &local).is_some(), "path exception");
    }

    #[test]
    fn password_locks() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        old.password = Some("hash".into());
        old.sessions.push(Session { id: "p".into(), list_id: "social".into(), started_at: 0, ends_at: now + MINUTE_MS, lock: LockMode::Password });
        assert!(active_blocks(&old, now, &local)[0].locked);
        let mut new = old.clone();
        new.sessions.clear();
        assert!(lock_violation(&old, &new, now, &local).is_some(), "password-locked blocks need the password");
        let mut new = old.clone();
        new.password = None;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "removing the password");
        // Stricter wins when merging: password beats text, timer beats password.
        let mut st = State::default();
        start_or_merge_session(&mut st, "social", 0, 10, LockMode::Text, "a".into());
        start_or_merge_session(&mut st, "social", 0, 10, LockMode::Password, "b".into());
        assert_eq!(st.sessions[0].lock, LockMode::Password);
        start_or_merge_session(&mut st, "social", 0, 10, LockMode::Timer, "c".into());
        assert_eq!(st.sessions[0].lock, LockMode::Timer);
    }

    #[test]
    fn protected_programs_are_never_enforced() {
        let mut state = State::default();
        state.lists[0].apps = ["explorer.exe", "OpenBlocker.exe", "msedgewebview2.exe", "csrss", "steam.exe", "Taskmgr.exe"]
            .iter()
            .map(|e| AppEntry { name: e.to_string(), exe: e.to_string(), path: None })
            .collect();
        let blocks = vec![ActiveBlock { list_id: "social".into(), source: Source::Session, ref_id: "x".into(), ends_at: 1, locked: false, password: false }];
        let (_, apps) = enforced_targets(&state, &blocks);
        assert_eq!(apps, ["steam.exe".to_string(), "taskmgr.exe".to_string()].into());
        assert!(is_protected_exe("C:\\Windows\\explorer.exe"));
    }

    #[test]
    fn ending_blocks_early() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        let mut s = sched(&[2], 600, 840); // Wednesdays 10:00-14:00
        s.locked = true;
        old.schedules.push(s);
        assert!(end_block(&mut old.clone(), "nope", now, &local).is_err());

        // A skip hides the block until its planned end, and can't be published
        // by the app for a locked block.
        let mut new = old.clone();
        end_block(&mut new, "s", now, &local).unwrap();
        assert!(active_blocks(&new, now, &local).is_empty());
        assert!(lock_violation(&old, &new, now, &local).is_some());
        assert_eq!(new.skips[0].until, now + 2 * 60 * MINUTE_MS);

        // Turning on the password escape while locked would loosen it.
        let mut new = old.clone();
        new.schedules[0].password = true;
        assert!(lock_violation(&old, &new, now, &local).is_some(), "adding a password escape");
        // Taking it away is fine.
        let mut pw = old.clone();
        pw.schedules[0].password = true;
        assert!(active_blocks(&pw, now, &local)[0].password);
        assert!(lock_violation(&pw, &old, now, &local).is_none(), "removing the escape");

        // The focus timer is stopped, not skipped.
        let mut st = State::default();
        let cfg = PomodoroConfig { list_id: Some("social".into()), ..Default::default() };
        st.pomodoro = Some(new_pomodoro(cfg, now));
        end_block(&mut st, "pomodoro", now, &local).unwrap();
        assert!(st.pomodoro.is_none());

        // Old skips are cleaned up.
        let mut st = new.clone();
        tick(&mut st, now + 24 * 60 * MINUTE_MS);
        assert!(st.skips.is_empty());
    }

    #[test]
    fn app_allowlist() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut old = State::default();
        let app = |exe: &str| AppEntry { name: exe.into(), exe: exe.into(), path: None };
        old.lists[2].app_mode = ListMode::Allow;
        old.lists[2].categories.clear();
        old.lists[2].apps = vec![app("code.exe"), app("firefox.exe")];
        old.sessions.push(Session { id: "s".into(), list_id: "games".into(), started_at: 0, ends_at: now + MINUTE_MS, lock: LockMode::Timer });
        let blocks = active_blocks(&old, now, &local);
        // Allowed apps aren't blocked, and only they (plus Windows) may run.
        assert!(enforced_targets(&old, &blocks).1.is_empty());
        let allowed = allowed_apps(&old, &blocks).unwrap();
        assert!(app_allowed(&allowed, "Code.exe"));
        assert!(app_allowed(&allowed, "explorer.exe"));
        assert!(app_allowed(&allowed, "openblocker.exe"));
        assert!(!app_allowed(&allowed, "steam.exe"));
        assert_eq!(allowed_apps(&State::default(), &blocks), None);

        // Locked: allowed apps can be removed, not added; the mode is fixed.
        let mut new = old.clone();
        new.lists[2].apps.pop();
        assert!(lock_violation(&old, &new, now, &local).is_none());
        let mut new = old.clone();
        new.lists[2].apps.push(app("steam.exe"));
        assert!(lock_violation(&old, &new, now, &local).is_some());
        let mut new = old.clone();
        new.lists[2].app_mode = ListMode::Block;
        assert!(lock_violation(&old, &new, now, &local).is_some());
    }

    #[test]
    fn permanent_blocks_and_fallback() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut st = State::default();
        st.permanent.push(PermanentBlock { id: "p".into(), list_id: "video".into(), lock: LockMode::Text, since: 0 });
        let blocks = active_blocks(&st, now, &local);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].locked && !blocks[0].password && blocks[0].ends_at == PERMANENT_END);
        // A text-locked permanent block can't be removed by publishing.
        let mut new = st.clone();
        new.permanent.clear();
        assert!(lock_violation(&st, &new, now, &local).is_some());
        // ...but the service can end it (after the text was typed).
        end_block(&mut new, "p", now, &local).unwrap_or(());
        let mut ended = st.clone();
        end_block(&mut ended, "p", now, &local).unwrap();
        assert!(ended.permanent.is_empty());

        // Extension-only features and the strict fallback.
        let mut st = State::default();
        st.lists[1].categories.clear();
        st.lists[1].sites = vec!["youtube.com/shorts".into(), "example.com".into()];
        st.permanent.push(PermanentBlock { id: "p".into(), list_id: "video".into(), lock: LockMode::None, since: 0 });
        let blocks = active_blocks(&st, now, &local);
        assert!(needs_extension(&st, &blocks));
        assert_eq!(strict_fallback_domains(&st, &blocks), ["youtube.com".to_string()].into());
        st.lists[1].sites = vec!["example.com".into()];
        assert!(!needs_extension(&st, &blocks));
        st.lists[1].youtube_channels = vec!["@veritasium".into()];
        assert!(needs_extension(&st, &blocks));
        assert!(strict_fallback_domains(&st, &blocks).contains("youtu.be"));

        // Loosening the fallback or private windows while locked is refused.
        let mut old = State::default();
        old.sessions.push(Session { id: "s".into(), list_id: "social".into(), started_at: 0, ends_at: now + MINUTE_MS, lock: LockMode::Timer });
        let mut new = old.clone();
        new.settings.extension_fallback = ExtensionFallback::Lenient;
        assert!(lock_violation(&old, &new, now, &local).is_some());
        let mut new = old.clone();
        new.settings.private_windows = PrivateWindows::Off;
        assert!(lock_violation(&old, &new, now, &local).is_some());
        let mut new = old.clone();
        new.settings.private_windows = PrivateWindows::On;
        assert!(lock_violation(&old, &new, now, &local).is_none());
    }

    #[test]
    fn super_strict_mode() {
        let local = at(4, 12, 0);
        let now = 1_000_000;
        let mut st = State::default();
        st.settings.super_strict = true;
        assert!(!super_strict(&st, &active_blocks(&st, now, &local)), "only while something is blocked");
        // Any block counts, even one without websites (here: an app-only list).
        st.lists[2].categories.clear();
        st.lists[2].apps = vec![AppEntry { name: "Steam".into(), exe: "steam.exe".into(), path: None }];
        st.sessions.push(Session { id: "s".into(), list_id: "games".into(), started_at: 0, ends_at: now + MINUTE_MS, lock: LockMode::None });
        let blocks = active_blocks(&st, now, &local);
        assert!(enforced_targets(&st, &blocks).0.is_empty());
        assert!(super_strict(&st, &blocks));
        // Turning it off: fine without a lock, refused with one.
        let mut new = st.clone();
        new.settings.super_strict = false;
        assert!(lock_violation(&st, &new, now, &local).is_none());
        let mut locked = st.clone();
        locked.sessions[0].lock = LockMode::Timer;
        let mut new = locked.clone();
        new.settings.super_strict = false;
        assert!(lock_violation(&locked, &new, now, &local).is_some());
        let mut on = locked.clone();
        on.settings.super_strict = false;
        let mut new = on.clone();
        new.settings.super_strict = true;
        assert!(lock_violation(&on, &new, now, &local).is_none(), "turning it on is stricter");
    }
}
