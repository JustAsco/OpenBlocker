//! OpenBlocker desktop app: wires the platform-independent core to Tauri,
//! the OS (hosts file, processes) and the UI.

mod bridge;
mod platform;

use chrono::{Local, NaiveDateTime};
use openblocker_core::engine::{self, ActiveBlock, Event};
use openblocker_core::hosts;
use openblocker_core::model::*;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

const TICK: Duration = Duration::from_millis(1000);
const MAX_SESSION_MIN: u32 = 60 * 24 * 30;
const MAX_FREEZE_MIN: u32 = 60 * 12;
/// Key of the emergency-reset challenge in `Inner::challenges`.
const RESET_CHALLENGE: &str = "__reset__";

struct Inner {
    state: State,
    path: PathBuf,
    /// Unlock text per text-locked session id.
    challenges: HashMap<String, String>,
    /// Domains currently written to the hosts file (None = unknown / needs write).
    applied_sites: Option<BTreeSet<String>>,
    hosts_error: Option<String>,
    hosts_retry_at: i64,
    last_tick: i64,
    focus_carry_ms: i64,
    last_save: i64,
    bridge: Arc<bridge::Bridge>,
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
    elevated: bool,
    platform: &'static str,
    /// Browsers in which the extension is currently running.
    extension: Vec<bridge::BrowserSeen>,
    /// Browsers without the extension are being closed right now.
    extension_required: bool,
    /// Number of allowed sites while an allowlist is active.
    allowlist_sites: Option<usize>,
    bridge_error: Option<String>,
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

impl Inner {
    fn load(path: PathBuf, bridge: Arc<bridge::Bridge>) -> Self {
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<State>(&s).ok())
            .unwrap_or_default();
        Self {
            state,
            path,
            challenges: HashMap::new(),
            applied_sites: None,
            hosts_error: None,
            hosts_retry_at: 0,
            last_tick: now_ms(),
            focus_carry_ms: 0,
            last_save: now_ms(),
            bridge,
        }
    }

    fn save(&mut self) {
        self.last_save = now_ms();
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

    fn snapshot(&self) -> Snapshot {
        let active = self.blocks();
        let (sites, apps) = engine::enforced_targets(&self.state, &active);
        let allowed = engine::allowed_sites(&self.state, &active);
        let extension_required = self.extension_required(&active);
        Snapshot {
            state: self.state.clone(),
            status: Status {
                now: now_ms(),
                active,
                blocked_sites: sites.len(),
                blocked_apps: apps.len(),
                hosts_error: self.hosts_error.clone(),
                elevated: platform::can_write_hosts(),
                platform: std::env::consts::OS,
                extension: self.bridge.connected(now_ms()),
                extension_required,
                allowlist_sites: allowed.map(|a| a.len()),
                bridge_error: self.bridge.error.lock().unwrap().clone(),
            },
        }
    }

    /// Allowlists can only be enforced by the extension, so browsers without
    /// it are closed while one is active (or always, if the user opted in).
    fn extension_required(&self, active: &[ActiveBlock]) -> bool {
        engine::allowed_sites(&self.state, active).is_some()
            || (self.state.settings.require_extension && !engine::enforced_targets(&self.state, active).0.is_empty())
    }

    fn extension_rules(&self) -> bridge::Rules {
        let active = self.blocks();
        let (sites, _) = engine::enforced_targets(&self.state, &active);
        let allowed = engine::allowed_sites(&self.state, &active);
        let (paths, domains): (Vec<String>, Vec<String>) = sites.into_iter().partition(|s| hosts::is_path_site(s));
        // A path on a domain that is blocked anyway adds nothing.
        let paths = paths.into_iter().filter(|p| !domains.iter().any(|d| d == hosts::site_domain(p))).collect();
        let mut lists: Vec<String> = active
            .iter()
            .filter_map(|b| self.state.list(&b.list_id).map(|l| l.name.clone()))
            .collect();
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

    /// Commit a change from a command and return the fresh snapshot.
    fn commit(&mut self) -> Snapshot {
        self.applied_sites = None; // force re-evaluation on next tick
        self.hosts_retry_at = 0;
        self.save();
        self.snapshot()
    }
}

type Res<T> = Result<T, String>;

fn with<T>(shared: &tauri::State<'_, Shared>, f: impl FnOnce(&mut Inner) -> Res<T>) -> Res<T> {
    let mut inner = shared.lock().map_err(|_| "internal lock poisoned".to_string())?;
    f(&mut inner)
}

// ───────────────────────────── commands ─────────────────────────────

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
            if let Some(slot) = i.state.categories.iter_mut().find(|c| c.id == old.id) {
                *slot = category;
            }
        } else {
            if category.id.is_empty() {
                category.id = uuid::Uuid::new_v4().to_string();
            }
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
        let len = i.state.settings.unlock_text_length.clamp(10, 1000) as usize;
        Ok(i.challenges.entry(id).or_insert_with(|| random_text(len)).clone())
    })
}

#[tauri::command]
fn stop_session(shared: tauri::State<'_, Shared>, id: String, answer: Option<String>) -> Res<Snapshot> {
    with(&shared, |i| {
        let s = i.state.sessions.iter().find(|s| s.id == id).ok_or("Session not found.")?;
        match s.lock {
            LockMode::Timer => return Err(format!("Locked until {}. Stay strong 💪", fmt_until(s.ends_at))),
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
    with(&shared, |i| {
        if i.any_lock() {
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
async fn set_autostart(enabled: bool) -> Res<bool> {
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

fn engine_loop(app: AppHandle, shared: Shared) {
    let mut killer = platform::ProcessKiller::new();
    let mut last_browser_note = 0i64;
    loop {
        let (apps, snapshot, notes, settings, flush, frozen, require_ext, bridge) = {
            let mut i = shared.lock().unwrap();
            let now = now_ms();
            let elapsed = (now - i.last_tick).clamp(0, 5000);
            i.last_tick = now;

            let events = engine::tick(&mut i.state, now);
            let mut dirty = !events.is_empty();
            for e in &events {
                if *e == Event::PomodoroFocusCompleted {
                    i.day().pomodoros += 1;
                }
            }
            if !events.is_empty() {
                let live: BTreeSet<String> = i.state.sessions.iter().map(|s| s.id.clone()).collect();
                i.challenges.retain(|id, _| live.contains(id));
            }
            let notes: Vec<_> = events.iter().filter_map(|e| describe(e, &i.state)).collect();

            let blocks = i.blocks();
            if !blocks.is_empty() || i.state.freeze.is_some() {
                i.focus_carry_ms += elapsed;
                let secs = i.focus_carry_ms / 1000;
                if secs > 0 {
                    i.focus_carry_ms %= 1000;
                    i.day().focus_seconds += secs as u64;
                }
            }

            let (sites, mut apps) = engine::enforced_targets(&i.state, &blocks);
            let frozen = i.state.freeze.is_some();
            if frozen && i.state.settings.freeze_blocks_task_manager {
                apps.insert("taskmgr.exe".into());
            }
            let mut flush = false;
            if i.applied_sites.as_ref() != Some(&sites) && now >= i.hosts_retry_at {
                match platform::apply_hosts(&sites, i.state.settings.block_subdomains) {
                    Ok(changed) => {
                        flush = changed && i.state.settings.flush_dns;
                        i.applied_sites = Some(sites);
                        i.hosts_error = None;
                    }
                    Err(e) => {
                        i.hosts_error = Some(e);
                        i.hosts_retry_at = now + 15_000;
                    }
                }
            }
            if now - i.last_save > 60_000 {
                dirty = true;
            }
            if dirty {
                i.save();
            }
            let require_ext = i.extension_required(&blocks);
            (apps, i.snapshot(), notes, i.state.settings.clone(), flush, frozen, require_ext, i.bridge.clone())
        };

        if flush {
            platform::flush_dns();
        }
        for (title, body) in notes {
            notify(&app, settings.notifications, &title, &body);
        }
        let killed = killer.enforce(&apps);
        if !killed.is_empty() {
            {
                let mut i = shared.lock().unwrap();
                i.day().blocked_launches += killed.len() as u32;
            }
            let _ = app.emit("app-blocked", &killed);
            notify(&app, settings.notifications, "Blocked 🚫", &format!("{} was closed.", killed.join(", ")));
        }
        if require_ext {
            let now = now_ms();
            let closed = killer.close_unprotected_browsers(|exe| bridge.is_connected(exe, now));
            if !closed.is_empty() && now - last_browser_note > 60_000 {
                last_browser_note = now;
                notify(
                    &app,
                    settings.notifications,
                    "Browser closed 🧩",
                    &format!("{} doesn't have the OpenBlocker extension running.", closed.join(", ")),
                );
            }
        }
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
    // Leave the system clean: remove our hosts entries.
    let _ = platform::apply_hosts(&BTreeSet::new(), false);
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
            let shared: Shared = Arc::new(Mutex::new(Inner::load(dir.join("state.json"), bridge.clone())));
            app.manage(shared.clone());
            {
                let shared = shared.clone();
                std::thread::spawn(move || {
                    bridge::serve(bridge, move || shared.lock().unwrap().extension_rules());
                });
            }

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

            // Started from the logon task: stay in the tray.
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
