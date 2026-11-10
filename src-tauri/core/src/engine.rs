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
        for s in &list.sites {
            if let Some(d) = crate::hosts::normalize_domain(s) {
                sites.insert(d);
            }
        }
        for a in &list.apps {
            apps.insert(normalize_exe(&a.exe));
        }
    }
    (sites, apps)
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
    sites_ok && apps_ok
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
        let old = State::default().lists[0].clone();
        let mut grown = old.clone();
        grown.sites.push("pinterest.com".into());
        assert!(is_strict_superset(&old, &grown));
        let mut shrunk = old.clone();
        shrunk.sites.pop();
        assert!(!is_strict_superset(&old, &shrunk));
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
}
