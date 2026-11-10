//! The background service: `openblocker.exe --service`, installed as the
//! Windows service "OpenBlocker" running as SYSTEM.
//!
//! It does all privileged enforcement (hosts file, closing apps, the
//! extension bridge), so blocks keep working when the app is closed or
//! killed, and the app no longer needs administrator rights.
//!
//! The app stays in charge of editing: it publishes its state here after
//! every change. The service keeps its own copy in ProgramData (writable only
//! by SYSTEM and administrators) and refuses any update that would weaken a
//! running lock ([`engine::lock_violation`]), so neither killing the app nor
//! editing its data file gets around a lock. Ending a text lock or the
//! emergency reset need a challenge text that only the service hands out.
//!
//! While something is locked, the service doesn't accept "stop" requests, and
//! it restarts the app in the user's session if the app was killed (the app
//! shows the freeze screen and notifications).

use crate::{bridge, enforce, http, platform};
use chrono::{Local, NaiveDateTime};
use openblocker_core::engine;
use openblocker_core::model::State;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const NAME: &str = "OpenBlocker";
pub const PORT: u16 = 47614;
const HEADER: &str = "X-OpenBlocker-Service";
const RESET_KEY: &str = "__reset__";

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn local_now() -> NaiveDateTime {
    Local::now().naive_local()
}

// ───────────────────────────── protocol ─────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: String,
    pub hosts_error: Option<String>,
    pub bridge_error: Option<String>,
    pub browsers: Vec<bridge::BrowserSeen>,
    /// Sequence number of the last closed app.
    pub seq: u64,
    /// Apps closed after the `since` the client asked for.
    pub killed: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Rejection {
    error: String,
    state: State,
    generation: u64,
}

#[derive(Serialize, Deserialize)]
struct Generation {
    generation: u64,
}

#[derive(Serialize, Deserialize)]
struct KeyAnswer {
    key: String,
    #[serde(default)]
    answer: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Text {
    text: String,
}

#[derive(Serialize, Deserialize)]
struct ErrorBody {
    error: String,
}

/// Answer to a publish. Both carry the service's current *generation*: it
/// changes whenever the service ends a lock itself (typed unlock, emergency
/// reset), and a publish based on an older generation is refused, so a state
/// that was already on its way can't bring an ended lock back.
pub enum Publish {
    Accepted(u64),
    /// The service refused (out of date, or it would weaken a lock) and sent its own state.
    Rejected(String, Box<State>, u64),
}

/// The app's side of the service API.
pub mod client {
    use super::*;

    fn call(method: &str, path: &str, body: Option<&[u8]>) -> Result<(u16, Vec<u8>), String> {
        http::request(PORT, method, path, HEADER, body, Duration::from_secs(5))
    }

    fn error_of(body: &[u8]) -> String {
        serde_json::from_slice::<ErrorBody>(body)
            .map(|e| e.error)
            .unwrap_or_else(|_| "The OpenBlocker service refused the request.".into())
    }

    pub fn status(since: u64) -> Result<Status, String> {
        let (code, body) = http::request(PORT, "GET", &format!("/svc/v1/status?since={since}"), HEADER, None, Duration::from_secs(2))?;
        if code != 200 {
            return Err(format!("HTTP {code}"));
        }
        serde_json::from_slice(&body).map_err(|e| e.to_string())
    }

    pub fn state() -> Result<Option<State>, String> {
        let (code, body) = call("GET", "/svc/v1/state", None)?;
        match code {
            200 => serde_json::from_slice(&body).map(Some).map_err(|e| e.to_string()),
            404 => Ok(None),
            c => Err(format!("HTTP {c}")),
        }
    }

    pub fn publish(state_json: &str, generation: Option<u64>) -> Result<Publish, String> {
        let path = match generation {
            Some(g) => format!("/svc/v1/state?gen={g}"),
            None => "/svc/v1/state".into(),
        };
        let (code, body) = call("POST", &path, Some(state_json.as_bytes()))?;
        match code {
            200 => Ok(Publish::Accepted(serde_json::from_slice::<Generation>(&body).map_err(|e| e.to_string())?.generation)),
            409 => {
                let r: Rejection = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
                Ok(Publish::Rejected(r.error, Box::new(r.state), r.generation))
            }
            c => Err(format!("HTTP {c}")),
        }
    }

    pub fn challenge(key: &str) -> Result<String, String> {
        let req = serde_json::to_vec(&KeyAnswer { key: key.into(), answer: None }).unwrap();
        let (code, body) = call("POST", "/svc/v1/challenge", Some(&req))?;
        if code != 200 {
            return Err(error_of(&body));
        }
        serde_json::from_slice::<Text>(&body).map(|t| t.text).map_err(|e| e.to_string())
    }

    /// Ends a text-locked quick block (`key` = session id) or resets
    /// everything (`key` = "__reset__"). Returns the new generation.
    pub fn unlock(key: &str, answer: Option<String>) -> Result<u64, String> {
        let req = serde_json::to_vec(&KeyAnswer { key: key.into(), answer }).unwrap();
        let (code, body) = call("POST", "/svc/v1/unlock", Some(&req))?;
        if code == 200 {
            serde_json::from_slice::<Generation>(&body).map(|g| g.generation).map_err(|e| e.to_string())
        } else {
            Err(error_of(&body))
        }
    }

    pub fn reset_key() -> &'static str {
        RESET_KEY
    }

    /// Sends a category's community-list domains (one per line).
    pub fn upload_source(category_id: &str, domains: &BTreeSet<String>) -> Result<(), String> {
        let text = domains.iter().map(String::as_str).collect::<Vec<_>>().join("\n");
        let (code, body) = http::request(
            PORT,
            "PUT",
            &format!("/svc/v1/source?id={category_id}"),
            HEADER,
            Some(text.as_bytes()),
            Duration::from_secs(30),
        )?;
        if code == 200 {
            Ok(())
        } else {
            Err(error_of(&body))
        }
    }
}

// ───────────────────────────── service ─────────────────────────────

struct Svc {
    state: State,
    /// False until the app published something (nothing to enforce yet).
    has_state: bool,
    /// Bumped whenever the service itself ends a lock (see [`Publish`]).
    generation: u64,
    dir: PathBuf,
    challenges: HashMap<String, String>,
    killed: VecDeque<(u64, String)>,
    seq: u64,
    hosts_error: Option<String>,
    bridge: Arc<bridge::Bridge>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn random_text(len: usize) -> String {
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

impl Svc {
    fn load(dir: PathBuf, bridge: Arc<bridge::Bridge>) -> Self {
        let _ = std::fs::create_dir_all(dir.join("sources"));
        platform::protect_service_dir(&dir);
        let loaded = std::fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<State>(&s).ok());
        let mut svc = Self {
            has_state: loaded.is_some(),
            // Unique per run, so an app that talked to a previous run resyncs.
            generation: now_ms().max(0) as u64,
            state: loaded.unwrap_or_default(),
            dir,
            challenges: HashMap::new(),
            killed: VecDeque::new(),
            seq: 0,
            hosts_error: None,
            bridge,
        };
        svc.state.source_sites = svc.load_sources(&svc.state);
        svc
    }

    fn source_path(&self, id: &str) -> PathBuf {
        self.dir.join("sources").join(format!("{id}.txt"))
    }

    fn load_sources(&self, state: &State) -> std::collections::BTreeMap<String, Arc<BTreeSet<String>>> {
        state
            .categories
            .iter()
            .filter(|c| c.source.is_some() && valid_id(&c.id))
            .filter_map(|c| {
                let text = std::fs::read_to_string(self.source_path(&c.id)).ok()?;
                Some((c.id.clone(), Arc::new(text.lines().map(str::to_string).collect())))
            })
            .collect()
    }

    fn save(&self) {
        if let Ok(json) = serde_json::to_string(&self.state) {
            let tmp = self.dir.join("state.json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, self.dir.join("state.json"));
            }
        }
    }

    fn any_lock(&self) -> bool {
        self.state.freeze.is_some() || engine::active_blocks(&self.state, now_ms(), &local_now()).iter().any(|b| b.locked)
    }

    fn accept(&mut self, mut incoming: State) -> Result<(), String> {
        // Community lists only exist for categories that still have a source.
        incoming.source_sites = self
            .state
            .source_sites
            .iter()
            .filter(|(id, _)| incoming.category(id).is_some_and(|c| c.source.is_some()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if self.has_state {
            if let Some(why) = engine::lock_violation(&self.state, &incoming, now_ms(), &local_now()) {
                return Err(why);
            }
        }
        for id in self.state.source_sites.keys().filter(|id| !incoming.source_sites.contains_key(*id)) {
            let _ = std::fs::remove_file(self.source_path(id));
        }
        self.state = incoming;
        self.has_state = true;
        self.save();
        Ok(())
    }

    fn challenge(&mut self, key: &str) -> Result<String, String> {
        let len = if key == RESET_KEY {
            (self.state.settings.unlock_text_length as usize * 3).clamp(300, 1000)
        } else {
            let s = self.state.sessions.iter().find(|s| s.id == key).ok_or("Session not found.")?;
            if s.lock != openblocker_core::model::LockMode::Text {
                return Err("This block can't be unlocked with a text.".into());
            }
            self.state.settings.unlock_text_length.clamp(10, 1000) as usize
        };
        Ok(self.challenges.entry(key.into()).or_insert_with(|| random_text(len)).clone())
    }

    fn unlock(&mut self, key: &str, answer: Option<&str>) -> Result<u64, String> {
        let needs_text = key != RESET_KEY || self.any_lock();
        if needs_text && (answer.is_none() || self.challenges.get(key).map(String::as_str) != answer) {
            return Err("The text doesn't match.".into());
        }
        self.challenges.remove(key);
        if key == RESET_KEY {
            for id in self.state.source_sites.keys() {
                let _ = std::fs::remove_file(self.source_path(id));
            }
            self.state = engine::factory_reset(&self.state);
            self.challenges.clear();
        } else {
            self.state.sessions.retain(|s| s.id != key);
        }
        self.generation += 1;
        self.save();
        Ok(self.generation)
    }

    fn set_source(&mut self, id: &str, text: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Invalid category id.".into());
        }
        let mut domains: BTreeSet<String> = text.lines().filter_map(openblocker_core::hosts::normalize_domain).collect();
        // While a lock uses this category, lists can only grow.
        let now = now_ms();
        let local = local_now();
        if engine::category_locked_until(&self.state, id, now, &local).is_some() {
            if let Some(old) = self.state.source_sites.get(id) {
                domains.extend(old.iter().cloned());
            }
        }
        let body = domains.iter().map(String::as_str).collect::<Vec<_>>().join("\n");
        std::fs::write(self.source_path(id), body).map_err(|e| e.to_string())?;
        self.state.source_sites.insert(id.into(), Arc::new(domains));
        Ok(())
    }

    fn status(&self, since: u64) -> Status {
        Status {
            version: env!("CARGO_PKG_VERSION").into(),
            hosts_error: self.hosts_error.clone(),
            bridge_error: self.bridge.error.lock().unwrap().clone(),
            browsers: self.bridge.connected(now_ms()),
            seq: self.seq,
            killed: self.killed.iter().filter(|(s, _)| *s > since).map(|(_, n)| n.clone()).collect(),
        }
    }
}

fn respond<T: Serialize>(req: tiny_http::Request, code: u16, body: &T) {
    let json = serde_json::to_string(body).unwrap_or_else(|_| "{}".into());
    let _ = req.respond(tiny_http::Response::from_string(json).with_status_code(code).with_header(http::json_header()));
}

fn handle(svc: &Mutex<Svc>, mut req: tiny_http::Request) {
    if !http::trusted(&req, HEADER, PORT) {
        let _ = req.respond(tiny_http::Response::empty(404));
        return;
    }
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let mut body = String::new();
    if std::io::Read::read_to_string(&mut req.as_reader(), &mut body).is_err() {
        let _ = req.respond(tiny_http::Response::empty(400));
        return;
    }
    let mut s = svc.lock().unwrap();
    let err = |e: String| ErrorBody { error: e };
    match (req.method().as_str(), path.as_str()) {
        ("GET", "/svc/v1/status") => {
            let since = http::query_param(&url, "since").and_then(|v| v.parse().ok()).unwrap_or(u64::MAX);
            let st = s.status(since);
            respond(req, 200, &st)
        }
        ("GET", "/svc/v1/state") if s.has_state => respond(req, 200, &s.state),
        ("GET", "/svc/v1/state") => respond(req, 404, &err("No state yet.".into())),
        ("POST", "/svc/v1/state") => {
            let generation = s.generation;
            let stale = http::query_param(&url, "gen").and_then(|g| g.parse::<u64>().ok()).is_some_and(|g| g != generation);
            match serde_json::from_str::<State>(&body) {
                Err(e) => respond(req, 400, &err(e.to_string())),
                Ok(incoming) => match if stale { Err("Out of date.".to_string()) } else { s.accept(incoming) } {
                    Ok(()) => respond(req, 200, &Generation { generation }),
                    Err(e) => {
                        let state = s.state.clone();
                        respond(req, 409, &Rejection { error: e, state, generation })
                    }
                },
            }
        }
        ("POST", "/svc/v1/challenge") => match serde_json::from_str::<KeyAnswer>(&body).map_err(|e| e.to_string()).and_then(|k| s.challenge(&k.key)) {
            Ok(text) => respond(req, 200, &Text { text }),
            Err(e) => respond(req, 400, &err(e)),
        },
        ("POST", "/svc/v1/unlock") => match serde_json::from_str::<KeyAnswer>(&body)
            .map_err(|e| e.to_string())
            .and_then(|k| s.unlock(&k.key, k.answer.as_deref()))
        {
            Ok(generation) => respond(req, 200, &Generation { generation }),
            Err(e) => respond(req, 403, &err(e)),
        },
        ("PUT", "/svc/v1/source") => {
            let id = http::query_param(&url, "id").unwrap_or("").to_string();
            match s.set_source(&id, &body) {
                Ok(()) => respond(req, 200, &serde_json::json!({})),
                Err(e) => respond(req, 400, &err(e)),
            }
        }
        _ => {
            let _ = req.respond(tiny_http::Response::empty(404));
        }
    }
}

const RUN: u8 = 0;
const STOP: u8 = 1;
const SHUTDOWN: u8 = 2;

/// The service's main loop. `report_lock(locked)` is called whenever the
/// lock state changes (the Windows service then refuses "stop" while locked).
fn main_loop(dir: PathBuf, control: Arc<AtomicU8>, report_lock: impl Fn(bool)) {
    let bridge = Arc::new(bridge::Bridge::default());
    let svc = Arc::new(Mutex::new(Svc::load(dir, bridge.clone())));
    {
        let bridge = bridge.clone();
        std::thread::spawn(move || bridge::run(bridge, || true));
    }
    {
        let svc = svc.clone();
        std::thread::spawn(move || loop {
            match tiny_http::Server::http(("127.0.0.1", PORT)) {
                Ok(server) => {
                    for req in server.incoming_requests() {
                        handle(&svc, req);
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(3)),
            }
        });
    }
    let mut enforcer = enforce::Enforcer::new();
    let mut sys = sysinfo::System::new().ok();
    let mut last_locked = None;
    let mut last_launch = 0i64;
    while control.load(Ordering::Relaxed) == RUN {
        let now = now_ms();
        let local = local_now();
        let (state, locked) = {
            let mut s = svc.lock().unwrap();
            if !engine::tick(&mut s.state, now).is_empty() {
                s.save();
            }
            let locked = s.any_lock();
            (s.has_state.then(|| s.state.clone()), locked)
        };
        if let Some(state) = state {
            let out = enforcer.run(&state, &bridge, now, &local);
            let mut s = svc.lock().unwrap();
            s.hosts_error = enforcer.hosts_error.clone();
            for name in out.killed {
                s.seq += 1;
                let seq = s.seq;
                s.killed.push_back((seq, name));
                if s.killed.len() > 100 {
                    s.killed.pop_front();
                }
            }
        }
        if last_locked != Some(locked) {
            report_lock(locked);
            last_locked = Some(locked);
        }
        // Watchdog: the app shows the freeze screen and notifications, and
        // refuses to quit while locked; if it's gone anyway, it was killed.
        if locked && now - last_launch > 20_000 {
            if let Some(sys) = sys.as_mut() {
                if !platform::ui_running_in_console_session(sys) {
                    last_launch = now;
                    let _ = platform::launch_ui_in_console_session("--minimized");
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    // A real stop (only possible with nothing locked) leaves the hosts file
    // clean; at shutdown the blocks stay so they hold right after boot.
    if control.load(Ordering::Relaxed) == STOP {
        enforcer.clear();
    }
}

/// `openblocker --service-console`: the service loop in the foreground, for
/// development. Data goes to `OPENBLOCKER_SERVICE_DIR` if set.
pub fn run_console() {
    let dir = std::env::var_os("OPENBLOCKER_SERVICE_DIR").map(PathBuf::from).unwrap_or_else(platform::service_data_dir);
    eprintln!("OpenBlocker service (console mode), data in {}", dir.display());
    main_loop(dir, Arc::new(AtomicU8::new(RUN)), |locked| eprintln!("locked: {locked}"));
}

/// `openblocker --uninstall-check`, run by the installer: exit code 1 if a
/// locked block or freeze is running (uninstalling/updating is refused then).
pub fn uninstall_check() -> i32 {
    let state = std::fs::read_to_string(platform::service_data_dir().join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<State>(&s).ok());
    let locked = state.is_some_and(|s| {
        s.freeze.as_ref().is_some_and(|f| f.ends_at > now_ms()) || engine::active_blocks(&s, now_ms(), &local_now()).iter().any(|b| b.locked)
    });
    i32::from(locked)
}

#[cfg(windows)]
pub mod windows_service_main {
    use super::*;
    use std::ffi::OsString;
    use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType};
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    define_windows_service!(ffi_service_main, service_main);

    /// `openblocker --service`, started by the Service Control Manager.
    pub fn run() -> Result<(), String> {
        service_dispatcher::start(NAME, ffi_service_main).map_err(|e| e.to_string())
    }

    fn service_main(_args: Vec<OsString>) {
        let control = Arc::new(AtomicU8::new(RUN));
        let c = control.clone();
        let Ok(handle) = service_control_handler::register(NAME, move |ev| match ev {
            ServiceControl::Stop => {
                c.store(STOP, Ordering::Relaxed);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                c.store(SHUTDOWN, Ordering::Relaxed);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }) else {
            return;
        };
        let status = |state: ServiceState, accept: ServiceControlAccept| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        let _ = handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN));
        main_loop(platform::service_data_dir(), control, |locked| {
            // While locked, "stop" isn't offered at all.
            let accept = if locked {
                ServiceControlAccept::SHUTDOWN
            } else {
                ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
            };
            let _ = handle.set_service_status(status(ServiceState::Running, accept));
        });
        let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()));
    }
}
