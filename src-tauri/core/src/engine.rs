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
            });
        }
    }
    for sch in &state.schedules {
        if let Some(left) = schedule_remaining_ms(sch, local) {
            out.push(ActiveBlock {
                list_id: sch.list_id.clone(),
                source: Source::Schedule,
                ref_id: sch.id.clone(),
                ends_at: now_ms + left,
                locked: sch.locked,
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
                });
            }
        }
    }
    // Drop blocks referencing deleted lists.
    out.retain(|b| state.list(&b.list_id).is_some());
    out
}

/// Union of every domain and executable that must be blocked.
pub fn enforced_targets(state: &State, blocks: &[ActiveBlock]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut sites = BTreeSet::new();
    let mut apps = BTreeSet::new();
    let ids: BTreeSet<&str> = blocks.iter().map(|b| b.list_id.as_str()).collect();
    for list in state.lists.iter().filter(|l| ids.contains(l.id.as_str())) {
        let (list_sites, list_apps) = list_items(state, list);
        // Allowlist sites are *allowed*, not blocked; their apps are still blocked.
        if list.mode == ListMode::Block {
            sites.extend(list_sites);
        }
        apps.extend(list_apps);
    }
    (sites, apps)
}

/// A list's own items plus those of its categories (normalised).
pub fn list_items(state: &State, list: &BlockList) -> (BTreeSet<String>, BTreeSet<String>) {
    let cats = list.categories.iter().filter_map(|id| state.category(id));
    let sites = list
        .sites
        .iter()
        .chain(cats.clone().flat_map(|c| &c.sites))
        .filter_map(|s| crate::hosts::normalize_site(s))
        .collect();
    let apps = list.apps.iter().chain(cats.flat_map(|c| &c.apps)).map(|a| normalize_exe(&a.exe)).collect();
    (sites, apps)
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

fn strictness(l: LockMode) -> u8 {
    match l {
        LockMode::None => 0,
        LockMode::Text => 1,
        LockMode::Timer => 2,
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
    events
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
}
