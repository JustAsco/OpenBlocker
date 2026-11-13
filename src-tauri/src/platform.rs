//! Operating-system integration: hosts file, killing processes, elevation,
//! discovering installed apps and their icons.

use openblocker_core::{engine, hosts};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub name: String,
    pub exe: String,
    pub path: Option<String>,
    pub running: bool,
}

pub fn hosts_path() -> PathBuf {
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        PathBuf::from(root).join("System32\\drivers\\etc\\hosts")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/etc/hosts")
    }
}

/// Whether we have permission to modify the hosts file (i.e. are elevated).
pub fn can_write_hosts() -> bool {
    std::fs::OpenOptions::new().append(true).open(hosts_path()).is_ok()
}

/// Rewrites our managed section of the hosts file. `expand` picks the domains
/// that also get www./m. variants. Returns Ok(true) if the file changed.
pub fn apply_hosts(domains: &BTreeSet<String>, subdomains: bool, expand: impl Fn(&str) -> bool) -> Result<bool, String> {
    let path = hosts_path();
    let existing = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read hosts file: {e}"))?;
    let section = hosts::render_section(domains, subdomains, expand, hosts::newline_for(&existing));
    let merged = hosts::merge(&existing, &section);
    if merged == existing {
        return Ok(false);
    }
    std::fs::write(&path, merged).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            "Website blocking needs administrator rights.".to_string()
        } else {
            format!("Cannot write hosts file: {e}")
        }
    })?;
    Ok(true)
}

pub fn flush_dns() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("ipconfig")
            .arg("/flushdns")
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("resolvectl").arg("flush-caches").status();
    }
}

/// Restart the current executable with a UAC prompt.
pub fn relaunch_as_admin() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().replace('\'', "''");
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &format!("Start-Process -FilePath '{exe}' -Verb RunAs"),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Elevation was cancelled.".into())
        }
    }
    #[cfg(not(windows))]
    {
        Err("Please restart OpenBlocker with sudo / as root.".into())
    }
}

/// Process watcher that closes blocked executables.
pub struct ProcessKiller {
    sys: Option<System>,
}

impl ProcessKiller {
    pub fn new() -> Self {
        Self { sys: System::new().ok() }
    }

    fn refresh(&mut self) -> Option<&System> {
        let sys = self.sys.as_mut()?;
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        Some(sys)
    }

    /// Kills every process matching one of `blocked` (normalised exe names).
    /// Returns the names of the processes that were closed.
    pub fn enforce(&mut self, blocked: &BTreeSet<String>) -> Vec<String> {
        if blocked.is_empty() {
            return vec![];
        }
        let own_exe = std::env::current_exe().ok();
        let Some(sys) = self.refresh() else { return vec![] };
        let mut killed = Vec::new();
        for (pid, proc_) in sys.processes() {
            let name = proc_.name().to_string_lossy();
            if !may_close(pid.as_u32(), &name, proc_.exe(), own_exe.as_deref()) {
                continue;
            }
            if blocked.iter().any(|b| engine::exe_matches(&name, b)) && proc_.kill() {
                killed.push(name.to_string());
            }
        }
        killed
    }

    /// Browsers running without a working extension (`has_extension` says
    /// whether an exe is covered), as (exe, friendly name). Browsers get 30 s
    /// after starting so the extension can check in.
    pub fn unprotected_browsers(&mut self, has_extension: impl Fn(&str) -> bool) -> Vec<(String, String)> {
        let now_s = chrono::Utc::now().timestamp().max(0) as u64;
        let own_exe = std::env::current_exe().ok();
        let Some(sys) = self.refresh() else { return vec![] };
        let mut out = BTreeMap::new();
        for (pid, p) in sys.processes() {
            let exe = p.name().to_string_lossy().to_lowercase();
            let Some(name) = crate::bridge::browser_name(&exe) else { continue };
            if !may_close(pid.as_u32(), &exe, p.exe(), own_exe.as_deref()) || has_extension(&exe) || now_s.saturating_sub(p.start_time()) < 30 {
                continue;
            }
            out.insert(exe, name.to_string());
        }
        out.into_iter().collect()
    }

    /// Closes a browser by ending its main process only (the one whose parent
    /// isn't the same browser). Its tab and helper processes then exit on
    /// their own, so there's no "Aw, Snap!" flash, and the browser offers to
    /// restore the tabs next time. Returns whether anything was ended.
    pub fn close_browser(&mut self, exe: &str) -> bool {
        let own_exe = std::env::current_exe().ok();
        let Some(sys) = self.refresh() else { return false };
        let mut closed = false;
        for (pid, p) in sys.processes() {
            let name = p.name().to_string_lossy().to_lowercase();
            if name != exe || !may_close(pid.as_u32(), &name, p.exe(), own_exe.as_deref()) {
                continue;
            }
            let child = p
                .parent()
                .and_then(|pp| sys.process(pp))
                .is_some_and(|parent| parent.name().to_string_lossy().eq_ignore_ascii_case(exe));
            if !child && p.kill() {
                closed = true;
            }
        }
        closed
    }

    /// Running user programs, used for autosuggestions.
    pub fn running_apps(&mut self) -> Vec<InstalledApp> {
        let Some(sys) = self.refresh() else { return vec![] };
        let mut out = BTreeMap::new();
        for proc_ in sys.processes().values() {
            let Some(path) = proc_.exe() else { continue };
            let p = path.to_string_lossy().to_string();
            let lower = p.to_lowercase();
            if lower.starts_with("c:\\windows") || lower.starts_with("/usr/lib") || lower.starts_with("/usr/libexec") {
                continue;
            }
            let exe = proc_.name().to_string_lossy().to_string();
            let name = pretty_name(&exe);
            out.entry(exe.to_lowercase()).or_insert(InstalledApp {
                name,
                exe,
                path: Some(p),
                running: true,
            });
        }
        out.into_values().collect()
    }
}

/// Safety net before closing any process: never this process or another
/// copy of OpenBlocker (even renamed), never a protected Windows program, and
/// never anything outside a user's desktop session. The service runs as
/// SYSTEM, so without the last rule a list could close system services.
fn may_close(pid: u32, name: &str, path: Option<&std::path::Path>, own_exe: Option<&std::path::Path>) -> bool {
    if pid == std::process::id() || engine::is_protected_exe(name) {
        return false;
    }
    if let (Some(p), Some(own)) = (path, own_exe) {
        if p == own {
            return false;
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        let mut session = 0u32;
        // Session 0 holds services; unknown sessions are left alone too.
        if unsafe { ProcessIdToSessionId(pid, &mut session) }.is_err() || session == 0 {
            return false;
        }
    }
    true
}

fn pretty_name(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe);
    let mut c = stem.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Apps found in the registry (Uninstall entries and App Paths).
pub fn installed_apps() -> Vec<InstalledApp> {
    #[cfg(windows)]
    {
        windows_impl::registry_apps()
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

/// PNG data URL of an executable's icon.
pub fn exe_icon(path: &str) -> Option<String> {
    #[cfg(windows)]
    {
        windows_impl::exe_icon(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::InstalledApp;
    use base64::Engine as _;
    use std::collections::BTreeMap;
    use winreg::enums::*;
    use winreg::RegKey;

    fn exe_from_icon_value(v: &str) -> Option<String> {
        let v = v.trim().trim_matches('"');
        let v = match v.rfind(',') {
            Some(i) if v[i + 1..].trim().trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => &v[..i],
            _ => v,
        };
        let v = v.trim().trim_matches('"');
        (v.to_lowercase().ends_with(".exe") && std::path::Path::new(v).exists()).then(|| v.to_string())
    }

    pub fn registry_apps() -> Vec<InstalledApp> {
        let mut out: BTreeMap<String, InstalledApp> = BTreeMap::new();
        let mut add = |name: String, path: String| {
            let exe = std::path::Path::new(&path)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            if exe.is_empty() || exe.to_lowercase().contains("unins") {
                return;
            }
            out.entry(exe.to_lowercase()).or_insert(InstalledApp {
                name,
                exe,
                path: Some(path),
                running: false,
            });
        };
        let uninstall = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
        let uninstall_wow = "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
        for (hive, key) in [
            (HKEY_LOCAL_MACHINE, uninstall),
            (HKEY_LOCAL_MACHINE, uninstall_wow),
            (HKEY_CURRENT_USER, uninstall),
        ] {
            let Ok(root) = RegKey::predef(hive).open_subkey(key) else { continue };
            for sub in root.enum_keys().flatten() {
                let Ok(k) = root.open_subkey(&sub) else { continue };
                let name: String = k.get_value("DisplayName").unwrap_or_default();
                let icon: String = k.get_value("DisplayIcon").unwrap_or_default();
                let system: u32 = k.get_value("SystemComponent").unwrap_or(0);
                if name.is_empty() || system == 1 {
                    continue;
                }
                if let Some(exe) = exe_from_icon_value(&icon) {
                    add(name, exe);
                }
            }
        }
        let app_paths = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths";
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            let Ok(root) = RegKey::predef(hive).open_subkey(app_paths) else { continue };
            for sub in root.enum_keys().flatten() {
                let Ok(k) = root.open_subkey(&sub) else { continue };
                let path: String = k.get_value("").unwrap_or_default();
                if let Some(exe) = exe_from_icon_value(&path) {
                    add(super::pretty_name(&sub), exe);
                }
            }
        }
        out.into_values().collect()
    }

    pub fn exe_icon(path: &str) -> Option<String> {
        use std::ffi::c_void;
        use windows::core::PCWSTR;
        use windows::Win32::Graphics::Gdi::*;
        use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
        use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
        use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut info = SHFILEINFOW::default();
            let ok = SHGetFileInfoW(
                PCWSTR(wide.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            if ok == 0 || info.hIcon.is_invalid() {
                return None;
            }
            let mut ii = ICONINFO::default();
            let result = (|| {
                GetIconInfo(info.hIcon, &mut ii).ok()?;
                let mut bm = BITMAP::default();
                if GetObjectW(
                    ii.hbmColor.into(),
                    std::mem::size_of::<BITMAP>() as i32,
                    Some(&mut bm as *mut _ as *mut c_void),
                ) == 0
                {
                    return None;
                }
                let (w, h) = (bm.bmWidth, bm.bmHeight);
                let mut bmi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -h, // top-down
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut buf = vec![0u8; (w * h * 4) as usize];
                let hdc = GetDC(None);
                let lines = GetDIBits(
                    hdc,
                    ii.hbmColor,
                    0,
                    h as u32,
                    Some(buf.as_mut_ptr() as *mut c_void),
                    &mut bmi,
                    DIB_RGB_COLORS,
                );
                ReleaseDC(None, hdc);
                if lines == 0 {
                    return None;
                }
                let has_alpha = buf.chunks(4).any(|p| p[3] != 0);
                for px in buf.chunks_mut(4) {
                    px.swap(0, 2); // BGRA -> RGBA
                    if !has_alpha {
                        px[3] = 255;
                    }
                }
                let mut png_bytes = Vec::new();
                {
                    let mut enc = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
                    enc.set_color(png::ColorType::Rgba);
                    enc.set_depth(png::BitDepth::Eight);
                    let mut writer = enc.write_header().ok()?;
                    writer.write_image_data(&buf).ok()?;
                }
                Some(format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(png_bytes)
                ))
            })();
            if !ii.hbmColor.is_invalid() {
                let _ = DeleteObject(ii.hbmColor.into());
            }
            if !ii.hbmMask.is_invalid() {
                let _ = DeleteObject(ii.hbmMask.into());
            }
            let _ = DestroyIcon(info.hIcon);
            result
        }
    }
}

// ───────────────────────────── autostart ─────────────────────────────
//
// The app no longer needs administrator rights (the background service does
// the privileged work), so a per-user "Run" registry entry is enough. Older
// versions used an elevated scheduled task; it's removed when found.

#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "OpenBlocker";

pub fn autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value(RUN_VALUE, &format!("\"{}\" --minimized", exe.to_string_lossy()))
                .map_err(|e| e.to_string())
        } else {
            match key.delete_value(RUN_VALUE) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Autostart is only implemented on Windows so far.".into())
    }
}

// ───────────────────────────── activity (usage limits) ─────────────────────────────

/// Executable name of the window the user is looking at.
pub fn foreground_exe() -> Option<String> {
    let (_, path) = foreground_process()?;
    path.rsplit(['\\', '/']).next().map(str::to_string)
}

/// Process id and full executable path of the foreground window.
fn foreground_process() -> Option<(u32, String)> {
    #[cfg(windows)]
    unsafe {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        Some((pid, String::from_utf16_lossy(&buf[..len as usize])))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// App allowlist: closes the program in front unless `allowed(exe)` says it
/// may be used. Only the foreground program is ever touched, so background
/// helpers (drivers' tray tools, accessibility tools, sync clients) keep
/// running. Programs from the Windows folder and everything [`may_close`]
/// protects are always left alone. Returns the closed program's name.
pub fn close_foreground_unless(allowed: impl Fn(&str) -> bool) -> Option<String> {
    let (pid, path) = foreground_process()?;
    let exe = path.rsplit(['\\', '/']).next()?.to_string();
    let windows_dir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()).to_lowercase();
    let lower = path.to_lowercase();
    if lower.starts_with(&format!("{windows_dir}\\")) || allowed(&exe) {
        return None;
    }
    let own_exe = std::env::current_exe().ok();
    if !may_close(pid, &exe, Some(std::path::Path::new(&path)), own_exe.as_deref()) {
        return None;
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid).ok()?;
        let ok = TerminateProcess(handle, 1).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| pretty_name(&exe))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Milliseconds since the last keyboard or mouse input.
pub fn idle_ms() -> u64 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !GetLastInputInfo(&mut info).as_bool() {
            return 0;
        }
        GetTickCount().wrapping_sub(info.dwTime) as u64
    }
    #[cfg(not(windows))]
    {
        0
    }
}

// ───────────────────────────── service support ─────────────────────────────

/// Where the background service keeps its protected copy of the state
/// (`C:\ProgramData\OpenBlocker`).
pub fn service_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into())).join("OpenBlocker")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/var/lib/openblocker")
    }
}

/// Lets only SYSTEM and administrators change the service's data; users may
/// read it. (ProgramData lets every user create files by default.)
pub fn protect_service_dir(dir: &std::path::Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("icacls")
            .arg(dir)
            .args(["/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-32-545:(OI)(CI)RX", "/Q"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
    }
}

/// Is a copy of our own executable (other than this process) running in the
/// interactive user's session?
pub fn ui_running_in_console_session(sys: &mut System) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
        let me = std::process::id();
        let Some(name) = std::env::current_exe().ok().and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_lowercase())) else {
            return false;
        };
        let console = unsafe { WTSGetActiveConsoleSessionId() };
        sys.refresh_processes(ProcessesToUpdate::All, true);
        sys.processes().iter().any(|(pid, p)| {
            let mut session = u32::MAX;
            pid.as_u32() != me
                && p.name().to_string_lossy().to_lowercase() == name
                && unsafe { ProcessIdToSessionId(pid.as_u32(), &mut session) }.is_ok()
                && session == console
        })
    }
    #[cfg(not(windows))]
    {
        let _ = sys;
        true
    }
}

/// Starts the app (our own executable) in the logged-in user's session, as
/// that user. Only possible from a service running as SYSTEM.
pub fn launch_ui_in_console_session(args: &str) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use std::ffi::c_void;
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
        use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
        use windows::Win32::System::Threading::{CreateProcessAsUserW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW};

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let session = WTSGetActiveConsoleSessionId();
        if session == u32::MAX {
            return Err("nobody is logged in".into());
        }
        let mut token = HANDLE::default();
        WTSQueryUserToken(session, &mut token).map_err(|e| e.to_string())?;
        let mut env: *mut c_void = std::ptr::null_mut();
        let _ = CreateEnvironmentBlock(&mut env, Some(token), false);
        let mut cmd: Vec<u16> = format!("\"{}\" {args}", exe.to_string_lossy()).encode_utf16().chain([0]).collect();
        let desktop: Vec<u16> = "winsta0\\default".encode_utf16().chain([0]).collect();
        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_ptr() as *mut u16),
            ..Default::default()
        };
        let mut pi = PROCESS_INFORMATION::default();
        let result = CreateProcessAsUserW(
            Some(token),
            PCWSTR::null(),
            Some(PWSTR(cmd.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_UNICODE_ENVIRONMENT,
            (!env.is_null()).then_some(env as *const c_void),
            PCWSTR::null(),
            &si,
            &mut pi,
        );
        if !env.is_null() {
            let _ = DestroyEnvironmentBlock(env);
        }
        let _ = CloseHandle(token);
        if result.is_ok() {
            let _ = CloseHandle(pi.hProcess);
            let _ = CloseHandle(pi.hThread);
        }
        result.map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        Err("not supported on this platform".into())
    }
}

// ───────────────────────────── freeze: system keys ─────────────────────────────

#[cfg(windows)]
static SWALLOW_KEYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// While frozen, swallow the keys that would leave the freeze screen: the
/// Windows keys (Start menu, Win+D, Win+Tab…), Alt+Tab, Alt+Esc, Ctrl+Esc and
/// Alt+F4. Ctrl+Alt+Del can't be blocked by any program, which is intended.
/// The hook lives on its own thread and is installed on first use.
pub fn swallow_system_keys(on: bool) {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering;
        static STARTED: std::sync::Once = std::sync::Once::new();
        SWALLOW_KEYS.store(on, Ordering::Relaxed);
        if on {
            STARTED.call_once(|| {
                std::thread::spawn(|| unsafe {
                    use windows::Win32::Foundation::HINSTANCE;
                    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
                    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, SetWindowsHookExW, MSG, WH_KEYBOARD_LL};
                    let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
                    if SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), module, 0).is_err() {
                        return;
                    }
                    // Low-level hooks are called through this thread's message loop.
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
                });
            });
        }
    }
    #[cfg(not(windows))]
    let _ = on;
}

#[cfg(windows)]
unsafe extern "system" fn key_hook(code: i32, wparam: windows::Win32::Foundation::WPARAM, lparam: windows::Win32::Foundation::LPARAM) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_APPS, VK_CONTROL, VK_ESCAPE, VK_F4, VK_LWIN, VK_RWIN, VK_TAB};
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN};
    if code == HC_ACTION as i32 && SWALLOW_KEYS.load(std::sync::atomic::Ordering::Relaxed) {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode as u16;
        let alt = kb.flags.0 & LLKHF_ALTDOWN.0 != 0;
        let ctrl = GetAsyncKeyState(VK_CONTROL.0 as i32) < 0;
        let swallow = vk == VK_LWIN.0
            || vk == VK_RWIN.0
            || vk == VK_APPS.0
            || (alt && (vk == VK_TAB.0 || vk == VK_ESCAPE.0 || vk == VK_F4.0))
            || (ctrl && vk == VK_ESCAPE.0);
        if swallow {
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}
