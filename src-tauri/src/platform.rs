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

/// Rewrites our managed section of the hosts file. Returns Ok(true) if the file changed.
pub fn apply_hosts(domains: &BTreeSet<String>, subdomains: bool) -> Result<bool, String> {
    let path = hosts_path();
    let existing = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read hosts file: {e}"))?;
    let section = hosts::render_section(domains, subdomains, hosts::newline_for(&existing));
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
        let own = std::process::id();
        let Some(sys) = self.refresh() else { return vec![] };
        let mut killed = Vec::new();
        for (pid, proc_) in sys.processes() {
            if pid.as_u32() == own {
                continue;
            }
            let name = proc_.name().to_string_lossy();
            if blocked.iter().any(|b| engine::exe_matches(&name, b)) && proc_.kill() {
                killed.push(name.to_string());
            }
        }
        killed
    }

    /// Closes browsers in which the extension isn't running. Browsers get a
    /// 30 s grace period after starting so the extension can check in.
    /// Returns friendly names of the browsers that were closed.
    pub fn close_unprotected_browsers(&mut self, has_extension: impl Fn(&str) -> bool) -> Vec<String> {
        let now_s = chrono::Utc::now().timestamp().max(0) as u64;
        let own = std::process::id();
        let Some(sys) = self.refresh() else { return vec![] };
        let mut closed = BTreeSet::new();
        for (pid, p) in sys.processes() {
            let exe = p.name().to_string_lossy().to_lowercase();
            let Some(name) = crate::bridge::browser_name(&exe) else { continue };
            if pid.as_u32() == own || has_extension(&exe) || now_s.saturating_sub(p.start_time()) < 30 {
                continue;
            }
            if p.kill() {
                closed.insert(name.to_string());
            }
        }
        closed.into_iter().collect()
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
// On Windows we register a Task Scheduler task that runs at logon with the
// highest privileges, so website blocking works from boot without a UAC
// prompt. (A plain "Run" registry key cannot start elevated programs.)

#[cfg(windows)]
const TASK_NAME: &str = "OpenBlocker";

#[cfg(windows)]
fn schtasks(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("schtasks").args(args).creation_flags(CREATE_NO_WINDOW).output()
}

pub fn autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        schtasks(&["/Query", "/TN", TASK_NAME]).map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let fail = |o: std::process::Output| {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if msg.to_lowercase().contains("denied") {
                "Changing this needs administrator rights.".to_string()
            } else {
                format!("Task Scheduler error: {msg}")
            }
        };
        if !enabled {
            let o = schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]).map_err(|e| e.to_string())?;
            return if o.status.success() || !autostart_enabled() { Ok(()) } else { Err(fail(o)) };
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let user = format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").unwrap_or_default()
        );
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts OpenBlocker at logon so your blocks stay active.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>--minimized</Arguments></Exec></Actions>
</Task>"#,
            user = xml_escape(&user),
            exe = xml_escape(&exe.to_string_lossy()),
        );
        // schtasks expects UTF-16 LE with BOM.
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(xml.encode_utf16().flat_map(|u| u.to_le_bytes()));
        let path = std::env::temp_dir().join("openblocker-task.xml");
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        let o = schtasks(&["/Create", "/TN", TASK_NAME, "/XML", &path.to_string_lossy(), "/F"]).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&path);
        let o = o?;
        if o.status.success() {
            Ok(())
        } else {
            Err(fail(o))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Autostart is only implemented on Windows so far.".into())
    }
}
