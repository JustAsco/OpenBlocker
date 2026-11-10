//! OpenBlocker desktop app: wires the platform-independent core to Tauri,
//! the OS and the UI. When the background service is installed (see
//! `service.rs`) it does the enforcing and this app only edits, counts usage
//! and shows things; otherwise the app enforces by itself.

mod bridge;
mod enforce;
mod http;
mod platform;
pub mod service;

use chrono::{Local, NaiveDateTime};
use openblocker_core::engine::{self, ActiveBlock, Event};
use openblocker_core::hosts;
use openblocker_core::model::*;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

const TICK: Duration = Duration::from_millis(1000);
const MAX_SESSION_MIN: u32 = 60 * 24 * 30;
const MAX_FREEZE_MIN: u32 = 60 * 12;
/// Key of the emergency-reset challenge.
const RESET_CHALLENGE: &str = "__reset__";
/// No input for this long = away; usage limits stop counting.
const IDLE_MS: u64 = 60_000;
/// Largest community list accepted (the hosts file has to stay workable).
const MAX_SOURCE_DOMAINS: usize = 250_000;
/// Without changes, the state is still sent to the service this often.
const PUBLISH_EVERY_MS: i64 = 30_000;

struct Inner {
    state: State,
    path: PathBuf,
    /// Downloaded community lists, one file per category.
    sources_dir: PathBuf,
    /// Unlock text per text-locked session id (only without the service).
    challenges: HashMap<String, String>,
    hosts_error: Option<String>,
    last_tick: i64,
    focus_carry_ms: i64,
    usage_carry_ms: i64,
    last_save: i64,
    /// A command changed the state; save it (and publish it) soon.
    dirty: bool,
    bridge: Arc<bridge::Bridge>,
    /// Latest status from the background service; None = not running.
    svc: Option<service::Status>,
    svc_up: Arc<AtomicBool>,
    /// The service's generation our state is based on (see `service::Publish`).
    svc_gen: Option<u64>,
    publish_now: bool,
    last_publish: i64,
    /// Ask the enforcer to rewrite the hosts file (retry after an error).
    retry_hosts: bool,
    /// "date/limit id" pairs already warned about (5 minutes left).
    limit_warned: BTreeSet<String>,
}

type Shared = Arc<Mutex<Inner>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    now: i64,
    active: Vec<ActiveBlock>,
    blocked_sites: usize,
    blocked_apps: usize,
    hosts_error: Option<String>,
    /// This process may edit the hosts file itself.
    elevated: bool,
    /// The background service is running and enforcing.
    service: bool,
    platform: &'static str,
    /// Browsers in which the extension is currently running.
    extension: Vec<bridge::BrowserSeen>,
    /// Browsers without the extension are being closed right now.
    extension_required: bool,
    /// Number of allowed sites while an allowlist is active.
    allowlist_sites: Option<usize>,
    bridge_error: Option<String>,
    /// Seconds used today per usage limit id.
    usage_today: BTreeMap<String, u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    state: State,
    status: Status,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn local_now() -> NaiveDateTime {
    Local::now().naive_local()
}

fn today_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn fmt_until(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|d| d.with_timezone(&Local).format("%a %H:%M").to_string())
        .unwrap_or_default()
}

fn load_sources(dir: &std::path::Path, state: &State) -> BTreeMap<String, Arc<BTreeSet<String>>> {
    state
        .categories
        .iter()
        .filter(|c| c.source.is_some())
        .filter_map(|c| {
            let text = std::fs::read_to_string(dir.join(format!("{}.txt", c.id))).ok()?;
            Some((c.id.clone(), Arc::new(text.lines().map(str::to_string).collect())))
        })
        .collect()
}

impl Inner {
    fn load(dir: PathBuf, bridge: Arc<bridge::Bridge>, svc_up: Arc<AtomicBool>) -> Self {
        let path = dir.join("state.json");
        let sources_dir = dir.join("sources");
        let mut state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<State>(&s).ok())
            .unwrap_or_default();
        state.source_sites = load_sources(&sources_dir, &state);
        Self {
            state,
            path,
            sources_dir,
            challenges: HashMap::new(),
            hosts_error: None,
            last_tick: now_ms(),
            focus_carry_ms: 0,
            usage_carry_ms: 0,
            last_save: now_ms(),
            dirty: false,
            bridge,
            svc: None,
            svc_up,
            svc_gen: None,
            publish_now: true,
            last_publish: 0,
            retry_hosts: false,
            limit_warned: BTreeSet::new(),
        }
    }

    fn save(&mut self) {
        self.last_save = now_ms();
        self.dirty = false;
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.state) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    fn blocks(&self) -> Vec<ActiveBlock> {
        engine::active_blocks(&self.state, now_ms(), &local_now())
    }

    fn browsers(&self, now: i64) -> Vec<bridge::BrowserSeen> {
        match &self.svc {
            Some(s) => s.browsers.clone(),
            None => self.bridge.connected(now),
        }
    }

    fn snapshot(&self) -> Snapshot {
        let now = now_ms();
        let active = self.blocks();
        let (sites, apps) = engine::enforced_targets(&self.state, &active);
        let allowed = engine::allowed_sites(&self.state, &active);
        let mut state = self.state.clone();
        // Usage history and huge community lists stay out of the UI payload.
        state.usage.clear();
        Snapshot {
            state,
            status: Status {
                now,
                blocked_sites: sites.len(),
                blocked_apps: apps.len(),
                hosts_error: match &self.svc {
                    Some(s) => s.hosts_error.clone(),
                    None => self.hosts_error.clone(),
                },
                elevated: platform::can_write_hosts(),
                service: self.svc.is_some(),
                platform: std::env::consts::OS,
                extension: self.browsers(now),
                extension_required: enforce::extension_required(&self.state, &active),
                allowlist_sites: allowed.map(|a| a.len()),
                bridge_error: match &self.svc {
                    Some(s) => s.bridge_error.clone(),
                    None => self.bridge.error.lock().unwrap().clone(),
                },
                usage_today: self.state.usage.get(&today_key()).cloned().unwrap_or_default(),
                active,
            },
        }
    }

    fn list_locked_until(&self, list_id: &str) -> Option<i64> {
        engine::list_locked_until(&self.state, list_id, now_ms(), &local_now())
    }

    /// Any locked block or freeze currently running?
    fn any_lock(&self) -> bool {
        self.state.freeze.is_some() || self.blocks().iter().any(|b| b.locked)
    }

    fn day(&mut self) -> &mut DayStats {
        self.state.stats.entry(today_key()).or_default()
    }

    /// Mark a command's change for saving/publishing and return the fresh snapshot.
    fn commit(&mut self) -> Snapshot {
        self.dirty = true;
        self.publish_now = true;
        self.retry_hosts = true;
        self.snapshot()
    }

    /// Takes over the service's state (it refused ours, so it knows better),
    /// keeping what only this app tracks.
    fn adopt(&mut self, mut theirs: State) {
        theirs.source_sites = load_sources(&self.sources_dir, &theirs);
        for (day, mine) in &self.state.stats {
            let t = theirs.stats.entry(day.clone()).or_default();
            t.focus_seconds = t.focus_seconds.max(mine.focus_seconds);
            t.blocked_launches = t.blocked_launches.max(mine.blocked_launches);
            t.pomodoros = t.pomodoros.max(mine.pomodoros);
        }
        self.state = theirs;
        self.save();
    }
}

type Res<T> = Result<T, String>;

/// Runs a command. Every change is checked against the lock rules the
/// background service also enforces, so nothing can weaken a running lock.
fn with<T>(shared: &tauri::State<'_, Shared>, f: impl FnOnce(&mut Inner) -> Res<T>) -> Res<T> {
    let mut inner = shared.lock().map_err(|_| "internal lock poisoned".to_string())?;
    let before = inner.state.clone();
    let out = f(&mut inner)?;
    if let Some(why) = engine::lock_violation(&before, &inner.state, now_ms(), &local_now()) {
        inner.state = before;
        inner.dirty = false;
        return Err(why);
    }
    if inner.dirty {
        inner.save();
    }
    Ok(out)
}

/// For the few commands that may legitimately end a lock (the typed unlock
/// text, the emergency reset). They check the challenge themselves.
fn with_unguarded<T>(shared: &tauri::State<'_, Shared>, f: impl FnOnce(&mut Inner) -> Res<T>) -> Res<T> {
    let mut inner = shared.lock().map_err(|_| "internal lock poisoned".to_string())?;
    let out = f(&mut inner)?;
    if inner.dirty {
        inner.save();
    }
    Ok(out)
}

#[tauri::command]
fn get_snapshot(shared: tauri::State<'_, Shared>) -> Res<Snapshot> {
    with(&shared, |i| Ok(i.snapshot()))
}

#[tauri::command]
fn save_list(shared: tauri::State<'_, Shared>, mut list: BlockList) -> Res<Snapshot> {
    with(&shared, |i| {
        list.name = list.name.trim().to_string();
        if list.name.is_empty() {
            return Err("Give the list a name.".into());
        }
        clean_items(&mut list.sites, &mut list.apps);
        let mut seen_cats = BTreeSet::new();
        list.categories
            .retain(|c| i.state.categories.iter().any(|x| &x.id == c) && seen_cats.insert(c.clone()));
        if let Some(old) = i.state.lists.iter().find(|l| l.id == list.id).cloned() {
            if let Some(until) = i.list_locked_until(&list.id) {
                if !engine::is_strict_superset(&old, &list) {
                    return Err(format!(
                        "“{}” is locked until {}. You can add items, but not remove them.",
                        old.name,
                        fmt_until(until)
                    ));
                }
            }
            if let Some(slot) = i.state.lists.iter_mut().find(|l| l.id == old.id) {
                *slot = list;
            }
        } else {
            if list.id.is_empty() {
                list.id = uuid::Uuid::new_v4().to_string();
            }
            i.state.lists.push(list);
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn delete_list(shared: tauri::State<'_, Shared>, id: String) -> Res<Snapshot> {
    with(&shared, |i| {
        if let Some(until) = i.list_locked_until(&id) {
            return Err(format!("This list is locked until {}.", fmt_until(until)));
        }
        i.state.lists.retain(|l| l.id != id);
        i.state.schedules.retain(|s| s.list_id != id);
        i.state.sessions.retain(|s| s.list_id != id);
        if let Some(p) = i.state.pomodoro.as_mut() {
            if p.config.list_id.as_deref() == Some(&id) {
                p.config.list_id = None;
            }
        }
        Ok(i.commit())
    })
}

fn clean_items(sites: &mut Vec<String>, apps: &mut Vec<AppEntry>) {
    let mut seen = BTreeSet::new();
    *sites = sites
        .iter()
        .filter_map(|s| hosts::normalize_site(s))
        .filter(|s| seen.insert(s.clone()))
        .collect();
    let mut seen_apps = BTreeSet::new();
    apps.retain(|a| !a.exe.trim().is_empty() && seen_apps.insert(engine::normalize_exe(&a.exe)));
}

#[tauri::command]
fn save_category(shared: tauri::State<'_, Shared>, mut category: Category) -> Res<Snapshot> {
    with(&shared, |i| {
        category.name = category.name.trim().to_string();
        if category.name.is_empty() {
            return Err("Give the category a name.".into());
        }
        clean_items(&mut category.sites, &mut category.apps);
        if let Some(old) = i.state.category(&category.id).cloned() {
            if let Some(until) = engine::category_locked_until(&i.state, &old.id, now_ms(), &local_now()) {
                if !engine::category_is_superset(&old, &category) {
                    return Err(format!(
                        "“{}” is used by a locked block until {}. You can add items, but not remove them.",
                        old.name,
                        fmt_until(until)
                    ));
                }
            }
            // The community list is managed by its own commands.
            category.source = old.source.clone();
            if let Some(slot) = i.state.categories.iter_mut().find(|c| c.id == old.id) {
                *slot = category;
            }
        } else {
            if category.id.is_empty() {
                category.id = uuid::Uuid::new_v4().to_string();
            }
            category.source = None;
            i.state.categories.push(category);
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn delete_category(shared: tauri::State<'_, Shared>, id: String) -> Res<Snapshot> {
    with(&shared, |i| {
        if let Some(until) = engine::category_locked_until(&i.state, &id, now_ms(), &local_now()) {
            return Err(format!("This category is used by a locked block until {}.", fmt_until(until)));
        }
        i.state.categories.retain(|c| c.id != id);
        for l in &mut i.state.lists {
            l.categories.retain(|c| c != &id);
        }
        Ok(i.commit())
    })
}

fn schedule_running_locked(i: &Inner, id: &str) -> Option<i64> {
    i.blocks()
        .into_iter()
        .find(|b| b.source == engine::Source::Schedule && b.ref_id == id && b.locked)
        .map(|b| b.ends_at)
}

#[tauri::command]
fn save_schedule(shared: tauri::State<'_, Shared>, mut schedule: Schedule) -> Res<Snapshot> {
    with(&shared, |i| {
        if i.state.list(&schedule.list_id).is_none() {
            return Err("Pick a block list for this schedule.".into());
        }
        schedule.days.retain(|d| *d < 7);
        schedule.days.sort();
        schedule.days.dedup();
        if schedule.days.is_empty() {
            return Err("Pick at least one day.".into());
        }
        if schedule.start >= 1440 || schedule.end >= 1440 {
            return Err("Invalid time.".into());
        }
        if let Some(until) = schedule_running_locked(i, &schedule.id) {
            return Err(format!("This schedule is locked and running until {}.", fmt_until(until)));
        }
        if schedule.id.is_empty() {
            schedule.id = uuid::Uuid::new_v4().to_string();
        }
        match i.state.schedules.iter_mut().find(|s| s.id == schedule.id) {
            Some(s) => *s = schedule,
            None => i.state.schedules.push(schedule),
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn delete_schedule(shared: tauri::State<'_, Shared>, id: String) -> Res<Snapshot> {
    with(&shared, |i| {
        if let Some(until) = schedule_running_locked(i, &id) {
            return Err(format!("This schedule is locked and running until {}.", fmt_until(until)));
        }
        i.state.schedules.retain(|s| s.id != id);
        Ok(i.commit())
    })
}

#[tauri::command]
fn start_session(shared: tauri::State<'_, Shared>, list_id: String, minutes: u32, lock: LockMode) -> Res<Snapshot> {
    with(&shared, |i| {
        if i.state.list(&list_id).is_none() {
            return Err("Unknown block list.".into());
        }
        if minutes == 0 || minutes > MAX_SESSION_MIN {
            return Err("Choose between 1 minute and 30 days.".into());
        }
        let now = now_ms();
        // Re-starting a list that is already running extends it instead of stacking.
        engine::start_or_merge_session(
            &mut i.state,
            &list_id,
            now,
            now + minutes as i64 * engine::MINUTE_MS,
            lock,
            uuid::Uuid::new_v4().to_string(),
        );
        Ok(i.commit())
    })
}

#[tauri::command]
fn extend_session(shared: tauri::State<'_, Shared>, id: String, minutes: u32) -> Res<Snapshot> {
    with(&shared, |i| {
        let s = i.state.sessions.iter_mut().find(|s| s.id == id).ok_or("Session not found.")?;
        s.ends_at += minutes.min(MAX_SESSION_MIN) as i64 * engine::MINUTE_MS;
        Ok(i.commit())
    })
}

fn random_text(len: usize) -> String {
    // No look-alike characters (0/O, 1/l/I) so the text is fair to type.
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut out = String::with_capacity(len);
    while out.len() < len {
        for b in uuid::Uuid::new_v4().as_bytes() {
            if out.len() < len {
                out.push(ALPHABET[*b as usize % ALPHABET.len()] as char);
            }
        }
    }
    out
}

#[tauri::command]
fn unlock_challenge(shared: tauri::State<'_, Shared>, id: String) -> Res<String> {
    with(&shared, |i| {
        if i.svc.is_some() {
            return service::client::challenge(&id);
        }
        let len = i.state.settings.unlock_text_length.clamp(10, 1000) as usize;
        Ok(i.challenges.entry(id).or_insert_with(|| random_text(len)).clone())
    })
}

#[tauri::command]
fn stop_session(shared: tauri::State<'_, Shared>, id: String, answer: Option<String>) -> Res<Snapshot> {
    with_unguarded(&shared, |i| {
        let s = i.state.sessions.iter().find(|s| s.id == id).ok_or("Session not found.")?;
        match s.lock {
            LockMode::Timer => return Err(format!("Locked until {}. Stay strong 💪", fmt_until(s.ends_at))),
            // The service checks the text and ends the block on its side too.
            LockMode::Text if i.svc.is_some() => i.svc_gen = Some(service::client::unlock(&id, answer)?),
            LockMode::Text => {
                let expected = i.challenges.get(&id).ok_or("Request the unlock text first.")?;
                if answer.as_deref() != Some(expected.as_str()) {
                    return Err("The text doesn't match.".into());
                }
            }
            LockMode::None => {}
        }
        i.challenges.remove(&id);
        i.state.sessions.retain(|s| s.id != id);
        Ok(i.commit())
    })
}

#[tauri::command]
fn pomodoro_start(shared: tauri::State<'_, Shared>, config: PomodoroConfig) -> Res<Snapshot> {
    with(&shared, |i| {
        if config.focus_min == 0 || config.focus_min > 240 {
            return Err("Focus length must be 1–240 minutes.".into());
        }
        if i.state.pomodoro.as_ref().is_some_and(|p| p.config.locked && p.phase == PomodoroPhase::Focus) {
            return Err("A locked focus session is already running.".into());
        }
        i.state.pomodoro = Some(engine::new_pomodoro(config, now_ms()));
        Ok(i.commit())
    })
}

fn pomodoro_guard(i: &Inner) -> Res<()> {
    match &i.state.pomodoro {
        None => Err("No pomodoro running.".into()),
        Some(p) if p.config.locked && p.phase == PomodoroPhase::Focus => {
            Err("This focus session is locked. You can do it!".into())
        }
        _ => Ok(()),
    }
}

#[tauri::command]
fn pomodoro_pause(shared: tauri::State<'_, Shared>) -> Res<Snapshot> {
    with(&shared, |i| {
        pomodoro_guard(i)?;
        let now = now_ms();
        let p = i.state.pomodoro.as_mut().unwrap();
        if p.paused_remaining.is_none() {
            p.paused_remaining = Some((p.phase_ends_at - now).max(0));
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn pomodoro_resume(shared: tauri::State<'_, Shared>) -> Res<Snapshot> {
    with(&shared, |i| {
        let now = now_ms();
        let p = i.state.pomodoro.as_mut().ok_or("No pomodoro running.")?;
        if let Some(rem) = p.paused_remaining.take() {
            p.phase_ends_at = now + rem;
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn pomodoro_skip(shared: tauri::State<'_, Shared>) -> Res<Snapshot> {
    with(&shared, |i| {
        pomodoro_guard(i)?;
        let p = i.state.pomodoro.clone().unwrap();
        // Skipping does not count as a completed pomodoro.
        let (next, _) = engine::advance_pomodoro(&p, now_ms());
        i.state.pomodoro = next;
        Ok(i.commit())
    })
}

#[tauri::command]
fn pomodoro_stop(shared: tauri::State<'_, Shared>) -> Res<Snapshot> {
    with(&shared, |i| {
        pomodoro_guard(i)?;
        i.state.pomodoro = None;
        Ok(i.commit())
    })
}

#[tauri::command]
fn start_freeze(shared: tauri::State<'_, Shared>, minutes: u32, message: String) -> Res<Snapshot> {
    with(&shared, |i| {
        if minutes == 0 || minutes > MAX_FREEZE_MIN {
            return Err("Freeze must be between 1 minute and 12 hours.".into());
        }
        if i.state.freeze.is_some() {
            return Err("Already frozen.".into());
        }
        let now = now_ms();
        i.state.freeze = Some(Freeze {
            started_at: now,
            ends_at: now + minutes as i64 * engine::MINUTE_MS,
            message,
        });
        Ok(i.commit())
    })
}

#[tauri::command]
fn save_settings(shared: tauri::State<'_, Shared>, settings: Settings) -> Res<Snapshot> {
    with(&shared, |i| {
        i.state.settings = settings;
        Ok(i.commit())
    })
}

#[tauri::command]
fn export_settings(shared: tauri::State<'_, Shared>, path: String) -> Res<()> {
    let backup = with(&shared, |i| Ok(engine::backup(&i.state, now_ms())))?;
    let json = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Couldn't save the file: {e}"))
}

#[tauri::command]
fn import_settings(shared: tauri::State<'_, Shared>, path: String) -> Res<Snapshot> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read the file: {e}"))?;
    let backup: engine::Backup = serde_json::from_str(&text).map_err(|_| "This isn't a valid OpenBlocker settings file.".to_string())?;
    with(&shared, |i| {
        let before = serde_json::to_string_pretty(&i.state).ok();
        engine::restore(&mut i.state, backup, now_ms(), &local_now())?;
        // Community lists live in their own files: keep the ones we have,
        // the others have to be downloaded again.
        i.state.source_sites = load_sources(&i.sources_dir, &i.state);
        let loaded: BTreeSet<String> = i.state.source_sites.keys().cloned().collect();
        for c in &mut i.state.categories {
            if !loaded.contains(&c.id) {
                c.source = None;
            }
        }
        if let Some(json) = before {
            let _ = std::fs::write(i.path.with_file_name("state.before-import.json"), json);
        }
        Ok(i.commit())
    })
}

/// The text to type for an emergency reset, or `None` when nothing is locked
/// and no typing is needed.
#[tauri::command]
fn reset_challenge(shared: tauri::State<'_, Shared>) -> Res<Option<String>> {
    with(&shared, |i| {
        if !i.any_lock() {
            return Ok(None);
        }
        if i.svc.is_some() {
            return service::client::challenge(RESET_CHALLENGE).map(Some);
        }
        // Deliberately much longer than a normal unlock: this ends *every* lock.
        let len = (i.state.settings.unlock_text_length as usize * 3).clamp(300, 1000);
        Ok(Some(i.challenges.entry(RESET_CHALLENGE.into()).or_insert_with(|| random_text(len)).clone()))
    })
}

/// Emergency reset: removes every block list, schedule, running block and
/// setting, for when someone locked themselves out (e.g. a 24/7 locked
/// schedule). The previous state is kept next to the data file.
#[tauri::command]
fn factory_reset(shared: tauri::State<'_, Shared>, answer: Option<String>) -> Res<Snapshot> {
    with_unguarded(&shared, |i| {
        if i.svc.is_some() {
            // The service decides whether the text was needed and correct.
            i.svc_gen = Some(service::client::unlock(RESET_CHALLENGE, answer)?);
        } else if i.any_lock() {
            let expected = i.challenges.get(RESET_CHALLENGE).ok_or("Request the reset text first.")?;
            if answer.as_deref() != Some(expected.as_str()) {
                return Err("The text doesn't match.".into());
            }
        }
        if let Ok(json) = serde_json::to_string_pretty(&i.state) {
            let _ = std::fs::write(i.path.with_file_name("state.before-reset.json"), json);
        }
        i.state = engine::factory_reset(&i.state);
        i.challenges.clear();
        let _ = std::fs::remove_dir_all(&i.sources_dir);
        Ok(i.commit())
    })
}

#[tauri::command]
fn save_limit(shared: tauri::State<'_, Shared>, mut limit: UsageLimit) -> Res<Snapshot> {
    with(&shared, |i| {
        let list = i.state.list(&limit.list_id).ok_or("Pick a block list for this limit.")?;
        if list.mode == ListMode::Allow {
            return Err("Limits only work with lists that block things, not allowlists.".into());
        }
        if limit.minutes == 0 || limit.minutes > 24 * 60 {
            return Err("Choose between 1 minute and 24 hours.".into());
        }
        limit.days.retain(|d| *d < 7);
        limit.days.sort();
        limit.days.dedup();
        if limit.days.is_empty() {
            return Err("Pick at least one day.".into());
        }
        if limit.id.is_empty() {
            limit.id = uuid::Uuid::new_v4().to_string();
        }
        match i.state.limits.iter_mut().find(|l| l.id == limit.id) {
            Some(l) => *l = limit,
            None => i.state.limits.push(limit),
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn delete_limit(shared: tauri::State<'_, Shared>, id: String) -> Res<Snapshot> {
    with(&shared, |i| {
        i.state.limits.retain(|l| l.id != id);
        Ok(i.commit())
    })
}

/// Stores a downloaded community list for a category. The UI downloads it
/// (the list sites allow that) and passes the raw text.
#[tauri::command]
fn set_category_source(shared: tauri::State<'_, Shared>, id: String, url: String, name: String, text: String) -> Res<Snapshot> {
    with(&shared, |i| {
        if i.state.category(&id).is_none() {
            return Err("Category not found.".into());
        }
        let mut domains = hosts::parse_domain_list(&text);
        if domains.is_empty() {
            return Err("No websites found in that list.".into());
        }
        if domains.len() > MAX_SOURCE_DOMAINS {
            return Err(format!(
                "That list has {} websites; OpenBlocker supports up to {MAX_SOURCE_DOMAINS} per list (bigger ones slow down every browser lookup).",
                domains.len()
            ));
        }
        // While a lock uses the category, its list can only grow.
        if engine::category_locked_until(&i.state, &id, now_ms(), &local_now()).is_some() {
            if let Some(old) = i.state.source_sites.get(&id) {
                domains.extend(old.iter().cloned());
            }
        }
        let _ = std::fs::create_dir_all(&i.sources_dir);
        let body = domains.iter().map(String::as_str).collect::<Vec<_>>().join("\n");
        std::fs::write(i.sources_dir.join(format!("{id}.txt")), body).map_err(|e| format!("Couldn't save the list: {e}"))?;
        if i.svc.is_some() {
            service::client::upload_source(&id, &domains)?;
        }
        let count = domains.len();
        i.state.source_sites.insert(id.clone(), Arc::new(domains));
        if let Some(c) = i.state.categories.iter_mut().find(|c| c.id == id) {
            c.source = Some(CategorySource {
                url,
                name,
                updated_at: now_ms(),
                count,
            });
        }
        Ok(i.commit())
    })
}

#[tauri::command]
fn remove_category_source(shared: tauri::State<'_, Shared>, id: String) -> Res<Snapshot> {
    with(&shared, |i| {
        i.state.source_sites.remove(&id);
        if let Some(c) = i.state.categories.iter_mut().find(|c| c.id == id) {
            c.source = None;
        }
        // While a lock uses the category this change is refused, so the file stays.
        if engine::category_locked_until(&i.state, &id, now_ms(), &local_now()).is_none() {
            let _ = std::fs::remove_file(i.sources_dir.join(format!("{id}.txt")));
        }
        Ok(i.commit())
    })
}

struct IconCache(Mutex<HashMap<String, Option<String>>>);

#[tauri::command]
async fn installed_apps() -> Res<Vec<platform::InstalledApp>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut running = platform::ProcessKiller::new().running_apps();
        let known: BTreeSet<String> = running.iter().map(|a| a.exe.to_lowercase()).collect();
        running.extend(
            platform::installed_apps()
                .into_iter()
                .filter(|a| !known.contains(&a.exe.to_lowercase())),
        );
        running.sort_by_key(|a| a.name.to_lowercase());
        running
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn app_icon(cache: tauri::State<'_, IconCache>, path: String) -> Res<Option<String>> {
    if let Some(hit) = cache.0.lock().unwrap().get(&path) {
        return Ok(hit.clone());
    }
    let p = path.clone();
    let icon = tauri::async_runtime::spawn_blocking(move || platform::exe_icon(&p))
        .await
        .map_err(|e| e.to_string())?;
    cache.0.lock().unwrap().insert(path, icon.clone());
    Ok(icon)
}

#[tauri::command]
async fn get_autostart() -> bool {
    tauri::async_runtime::spawn_blocking(platform::autostart_enabled).await.unwrap_or(false)
}

#[tauri::command]
async fn set_autostart(shared: tauri::State<'_, Shared>, enabled: bool) -> Res<bool> {
    if !enabled && shared.lock().map_err(|e| e.to_string())?.any_lock() {
        return Err("Autostart can't be turned off while a locked block is running.".into());
    }
    tauri::async_runtime::spawn_blocking(move || platform::set_autostart(enabled).map(|_| platform::autostart_enabled()))
        .await
        .map_err(|e| e.to_string())?
}

fn extension_dir(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("extension"));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extension");
    [bundled, Some(dev)]
        .into_iter()
        .flatten()
        .find(|p| p.join("manifest.json").exists())
        .map(|p| p.canonicalize().unwrap_or(p))
}

#[tauri::command]
fn extension_path(app: AppHandle) -> Option<String> {
    // Strip the \\?\ prefix canonicalize adds on Windows; browsers don't accept it.
    extension_dir(&app).map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}

#[tauri::command]
fn open_extension_folder(app: AppHandle) -> Res<()> {
    let dir = extension_path(app).ok_or("Extension folder not found.")?;
    #[cfg(windows)]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn relaunch_as_admin(app: AppHandle) -> Res<()> {
    platform::relaunch_as_admin()?;
    app.exit(0);
    Ok(())
}

// ───────────────────────────── engine loop ─────────────────────────────

fn notify(app: &AppHandle, enabled: bool, title: &str, body: &str) {
    if enabled {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn describe(event: &Event, state: &State) -> Option<(String, String)> {
    let list_name = |id: &str| state.list(id).map(|l| l.name.clone()).unwrap_or_default();
    Some(match event {
        Event::SessionEnded { list_id } => ("Block finished".into(), format!("“{}” is unblocked again.", list_name(list_id))),
        Event::PomodoroPhase { phase, round } => match phase {
            PomodoroPhase::Focus => ("Back to focus 🎯".into(), format!("Round {round} has started.")),
            PomodoroPhase::Break => ("Short break ☕".into(), "Stand up, stretch, drink water.".into()),
            PomodoroPhase::LongBreak => ("Long break 🌿".into(), "Great work! Take a proper rest.".into()),
        },
        Event::PomodoroFinished => ("Pomodoro complete 🎉".into(), "All rounds done. Nicely focused!".into()),
        Event::FreezeEnded => ("Freeze ended".into(), "Your computer is unlocked.".into()),
        Event::PomodoroFocusCompleted => return None,
    })
}

fn sync_freeze_windows(app: &AppHandle, frozen: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let existing: Vec<_> = app2
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| label.starts_with("freeze-"))
            .map(|(_, w)| w)
            .collect();
        if !frozen {
            for w in existing {
                let _ = w.destroy();
            }
            return;
        }
        if existing.is_empty() {
            let monitors = app2.available_monitors().unwrap_or_default();
            let count = monitors.len().max(1);
            for idx in 0..count {
                let mut b = WebviewWindowBuilder::new(&app2, format!("freeze-{idx}"), WebviewUrl::App("index.html#freeze".into()))
                    .title("OpenBlocker – Frozen")
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .minimizable(false)
                    .closable(false);
                if let Some(m) = monitors.get(idx) {
                    let scale = m.scale_factor();
                    let pos = m.position().to_logical::<f64>(scale);
                    let size = m.size().to_logical::<f64>(scale);
                    b = b.position(pos.x, pos.y).inner_size(size.width, size.height);
                }
                if let Ok(w) = b.build() {
                    let _ = w.set_fullscreen(true);
                    let _ = w.set_focus();
                }
            }
        } else {
            for w in existing {
                let _ = w.unminimize();
                let _ = w.set_always_on_top(true);
                if !w.is_focused().unwrap_or(false) && w.label() == "freeze-0" {
                    let _ = w.set_focus();
                }
            }
        }
    });
}

/// What the user is doing right now, for usage limits (None when idle).
fn current_activity(browsers: &[bridge::BrowserSeen], now: i64) -> engine::Activity {
    if platform::idle_ms() > IDLE_MS {
        return engine::Activity::default();
    }
    let exe = platform::foreground_exe();
    let url = exe
        .as_deref()
        .filter(|e| bridge::browser_name(e).is_some())
        .and_then(|e| bridge::active_url(browsers, e, now));
    engine::Activity { exe, url }
}

fn engine_loop(app: AppHandle, shared: Shared) {
    let mut enforcer = enforce::Enforcer::new();
    let mut last_browser_note = 0i64;
    let mut kill_seq: Option<u64> = None;
    loop {
        let now = now_ms();
        let local = local_now();
        let browsers = shared.lock().unwrap().browsers(now);
        let activity = current_activity(&browsers, now);

        // 1. Advance timers, stats and usage.
        let (mut notes, settings, publish, local_state) = {
            let mut i = shared.lock().unwrap();
            let elapsed = (now - i.last_tick).clamp(0, 5000);
            i.last_tick = now;

            let events = engine::tick(&mut i.state, now);
            let mut dirty = !events.is_empty() || i.dirty;
            for e in &events {
                if *e == Event::PomodoroFocusCompleted {
                    i.day().pomodoros += 1;
                }
            }
            if !events.is_empty() {
                let live: BTreeSet<String> = i.state.sessions.iter().map(|s| s.id.clone()).collect();
                i.challenges.retain(|id, _| live.contains(id));
                i.publish_now = true;
            }
            let mut notes: Vec<_> = events.iter().filter_map(|e| describe(e, &i.state)).collect();

            if !i.blocks().is_empty() || i.state.freeze.is_some() {
                i.focus_carry_ms += elapsed;
                let secs = i.focus_carry_ms / 1000;
                if secs > 0 {
                    i.focus_carry_ms %= 1000;
                    i.day().focus_seconds += secs as u64;
                }
            }

            i.usage_carry_ms += elapsed;
            let secs = (i.usage_carry_ms / 1000) as u64;
            i.usage_carry_ms %= 1000;
            for id in engine::add_usage(&mut i.state, &local, secs, &activity) {
                if let Some(name) = i.state.limits.iter().find(|l| l.id == id).and_then(|l| i.state.list(&l.list_id)).map(|l| l.name.clone()) {
                    notes.push(("Daily limit reached ⏳".into(), format!("“{name}” is blocked until midnight.")));
                }
                i.publish_now = true;
                dirty = true;
            }
            let day = today_key();
            for l in i.state.limits.clone() {
                let used = engine::limit_used(&i.state, &l.id, &local);
                let allowed = l.minutes as u64 * 60;
                let key = format!("{day}/{}", l.id);
                if engine::limit_applies(&l, &local) && allowed > 600 && used + 300 >= allowed && used < allowed && i.limit_warned.insert(key) {
                    if let Some(list) = i.state.list(&l.list_id) {
                        notes.push(("5 minutes left ⏳".into(), format!("Your daily time for “{}” is almost up.", list.name)));
                    }
                }
            }

            if now - i.last_save > 60_000 {
                dirty = true;
            }
            if dirty {
                i.save();
            }
            let publish = (i.svc.is_some() && (i.publish_now || now - i.last_publish > PUBLISH_EVERY_MS)).then(|| {
                i.publish_now = false;
                i.last_publish = now;
                (serde_json::to_string(&i.state).unwrap_or_default(), i.svc_gen)
            });
            let local_state = i.svc.is_none().then(|| {
                if std::mem::take(&mut i.retry_hosts) {
                    enforcer.invalidate();
                }
                i.state.clone()
            });
            (notes, i.state.settings.clone(), publish, local_state)
        };

        // 2. The service enforces; keep it up to date.
        if let Some((json, generation)) = publish {
            match service::client::publish(&json, generation) {
                Ok(service::Publish::Accepted(g)) => {
                    let mut i = shared.lock().unwrap();
                    i.svc_gen = Some(i.svc_gen.unwrap_or(0).max(g));
                }
                Ok(service::Publish::Rejected(_why, theirs, g)) => {
                    let mut i = shared.lock().unwrap();
                    i.adopt(*theirs);
                    i.svc_gen = Some(g);
                }
                Err(_) => shared.lock().unwrap().publish_now = true,
            }
        }
        let mut killed = vec![];
        let mut closed = vec![];
        match service::client::status(kill_seq.unwrap_or(u64::MAX)) {
            Ok(status) => {
                if kill_seq.is_some() {
                    killed = status.killed.clone();
                }
                kill_seq = Some(status.seq);
                let mut i = shared.lock().unwrap();
                if i.svc.is_none() {
                    // Just (re)connected: send our state right away.
                    i.publish_now = true;
                }
                i.svc = Some(status);
                i.svc_up.store(true, Ordering::Relaxed);
            }
            Err(_) => {
                let mut i = shared.lock().unwrap();
                if i.svc.take().is_some() {
                    enforcer.invalidate();
                }
                i.svc_gen = None;
                i.svc_up.store(false, Ordering::Relaxed);
                kill_seq = None;
            }
        }

        // 3. No service: enforce here (needs administrator rights for websites).
        if let Some(state) = local_state {
            let bridge = shared.lock().unwrap().bridge.clone();
            let out = enforcer.run(&state, &bridge, now, &local);
            shared.lock().unwrap().hosts_error = enforcer.hosts_error.clone();
            killed = out.killed;
            closed = out.closed_browsers;
        }

        if !killed.is_empty() {
            shared.lock().unwrap().day().blocked_launches += killed.len() as u32;
            let _ = app.emit("app-blocked", &killed);
            notes.push(("Blocked 🚫".into(), format!("{} was closed.", killed.join(", "))));
        }
        if !closed.is_empty() && now - last_browser_note > 60_000 {
            last_browser_note = now;
            notes.push(("Browser closed 🧩".into(), format!("{} doesn't have the OpenBlocker extension running.", closed.join(", "))));
        }
        for (title, body) in notes {
            notify(&app, settings.notifications, &title, &body);
        }
        let (snapshot, frozen) = {
            let i = shared.lock().unwrap();
            (i.snapshot(), i.state.freeze.is_some())
        };
        sync_freeze_windows(&app, frozen);
        let _ = app.emit("snapshot", &snapshot);
        std::thread::sleep(TICK);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn try_quit(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let mut i = shared.lock().unwrap();
    if i.any_lock() {
        let enabled = i.state.settings.notifications;
        drop(i);
        notify(app, enabled, "Can't quit right now", "A locked block is running. OpenBlocker stays on until it ends.");
        show_main(app);
        return;
    }
    // Leave the system clean: remove our hosts entries (unless the service
    // owns them; it keeps enforcing schedules while the app is closed).
    if i.svc.is_none() {
        let _ = platform::apply_hosts(&BTreeSet::new(), false, |_| true);
    }
    i.save();
    drop(i);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(IconCache(Mutex::new(HashMap::new())))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let bridge = Arc::new(bridge::Bridge::default());
            // Ask the service first, so the app doesn't grab the bridge port
            // for a moment when the service owns it.
            let svc_up = Arc::new(AtomicBool::new(service::client::status(u64::MAX).is_ok()));
            let shared: Shared = Arc::new(Mutex::new(Inner::load(dir, bridge.clone(), svc_up.clone())));
            app.manage(shared.clone());
            // The app serves the extension only while the service doesn't.
            std::thread::spawn(move || bridge::run(bridge, move || !svc_up.load(Ordering::Relaxed)));

            let open = MenuItem::with_id(app, "open", "Open OpenBlocker", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("OpenBlocker")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => try_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Started at logon or by the service: stay in the tray.
            if !std::env::args().any(|a| a == "--minimized") {
                show_main(app.handle());
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || engine_loop(handle, shared));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let shared = app.state::<Shared>();
                let i = shared.lock().unwrap();
                if window.label().starts_with("freeze-") {
                    if i.state.freeze.is_some() {
                        api.prevent_close();
                    }
                } else if window.label() == "main" {
                    if i.state.settings.close_to_tray || i.any_lock() {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        drop(i);
                        api.prevent_close();
                        try_quit(app);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            save_list,
            delete_list,
            save_category,
            delete_category,
            save_schedule,
            delete_schedule,
            start_session,
            extend_session,
            unlock_challenge,
            stop_session,
            pomodoro_start,
            pomodoro_pause,
            pomodoro_resume,
            pomodoro_skip,
            pomodoro_stop,
            start_freeze,
            save_settings,
            export_settings,
            import_settings,
            reset_challenge,
            factory_reset,
            save_limit,
            delete_limit,
            set_category_source,
            remove_category_source,
            installed_apps,
            app_icon,
            get_autostart,
            set_autostart,
            extension_path,
            open_extension_folder,
            relaunch_as_admin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenBlocker");
}
