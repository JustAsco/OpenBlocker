//! Persisted data model. Everything here is serialised as camelCase JSON and
//! mirrored in `src/lib/types.ts` on the frontend.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A program that should be closed while a block is active.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    /// Display name, e.g. "Steam".
    pub name: String,
    /// Executable file name, matched case-insensitively, e.g. "steam.exe".
    pub exe: String,
    /// Full path when known (used for icons only).
    #[serde(default)]
    pub path: Option<String>,
}

/// A named set of websites and apps that get blocked together.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockList {
    pub id: String,
    pub name: String,
    /// Hex color used throughout the UI (calendar, chips…).
    pub color: String,
    /// Emoji shown next to the name.
    pub icon: String,
    #[serde(default)]
    pub sites: Vec<String>,
    #[serde(default)]
    pub apps: Vec<AppEntry>,
    /// Ids of [`Category`]s whose sites and apps are included in this list.
    #[serde(default)]
    pub categories: Vec<String>,
}

/// A reusable, editable group of sites and apps ("Social media", "Adult", …).
/// Block lists include categories by reference, so editing a category
/// changes every list that uses it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    #[serde(default)]
    pub sites: Vec<String>,
    #[serde(default)]
    pub apps: Vec<AppEntry>,
}

/// Built-in catalog shared with the frontend (`src/lib/catalog.ts` imports the same file).
pub const CATALOG_JSON: &str = include_str!("../catalog.json");

#[derive(Deserialize)]
struct Catalog {
    categories: Vec<CatalogCategory>,
}

#[derive(Deserialize)]
struct CatalogCategory {
    id: String,
    name: String,
    icon: String,
    color: String,
    sites: Vec<CatalogSite>,
    apps: Vec<AppEntry>,
}

#[derive(Deserialize)]
struct CatalogSite {
    domain: String,
    #[serde(default)]
    related: Vec<String>,
}

/// The built-in categories, in their factory state.
pub fn default_categories() -> Vec<Category> {
    let catalog: Catalog = serde_json::from_str(CATALOG_JSON).expect("catalog.json is valid");
    catalog
        .categories
        .into_iter()
        .map(|c| Category {
            id: c.id,
            name: c.name,
            icon: c.icon,
            color: c.color,
            sites: c
                .sites
                .into_iter()
                .flat_map(|s| std::iter::once(s.domain).chain(s.related))
                .collect(),
            apps: c.apps,
        })
        .collect()
}

/// A weekly recurring block. `start == end` means "the whole day".
/// `end < start` means the block runs past midnight into the next day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub list_id: String,
    /// 0 = Monday … 6 = Sunday.
    pub days: Vec<u8>,
    /// Minutes since midnight.
    pub start: u16,
    /// Minutes since midnight.
    pub end: u16,
    /// When locked, the schedule cannot be edited or deleted while it is running.
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LockMode {
    /// Can be stopped any time.
    #[default]
    None,
    /// Requires typing a long random string to stop.
    Text,
    /// Cannot be stopped until the timer runs out.
    Timer,
}

/// A manually started, one-off block ("Block Instagram for 2 hours").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub list_id: String,
    /// Unix milliseconds.
    pub started_at: i64,
    /// Unix milliseconds.
    pub ends_at: i64,
    #[serde(default)]
    pub lock: LockMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PomodoroPhase {
    Focus,
    Break,
    LongBreak,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroConfig {
    pub focus_min: u32,
    pub break_min: u32,
    pub long_break_min: u32,
    /// Focus rounds before a long break.
    pub rounds: u32,
    /// Block list enforced during focus phases.
    #[serde(default)]
    pub list_id: Option<String>,
    /// If true, the pomodoro cannot be stopped/skipped during a focus phase.
    #[serde(default)]
    pub locked: bool,
    /// Stop automatically after this many focus rounds (None = run forever).
    #[serde(default)]
    pub total_rounds: Option<u32>,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self {
            focus_min: 25,
            break_min: 5,
            long_break_min: 15,
            rounds: 4,
            list_id: None,
            locked: false,
            total_rounds: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pomodoro {
    pub config: PomodoroConfig,
    pub phase: PomodoroPhase,
    /// 1-based focus round counter.
    pub round: u32,
    pub phase_started_at: i64,
    pub phase_ends_at: i64,
    /// Remaining ms when paused.
    #[serde(default)]
    pub paused_remaining: Option<i64>,
}

/// "Freeze" locks the whole computer behind a full-screen screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Freeze {
    pub started_at: i64,
    pub ends_at: i64,
    #[serde(default)]
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Flush the OS DNS cache after changing the hosts file.
    pub flush_dns: bool,
    /// Show desktop notifications (pomodoro phases, blocked apps).
    pub notifications: bool,
    /// Closing the window keeps OpenBlocker running in the tray.
    pub close_to_tray: bool,
    /// Also block `www.` and `m.` variants of each domain.
    pub block_subdomains: bool,
    /// Block Task Manager while the computer is frozen.
    pub freeze_blocks_task_manager: bool,
    /// Characters required to unlock a text-locked block.
    pub unlock_text_length: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            flush_dns: true,
            notifications: true,
            close_to_tray: true,
            block_subdomains: true,
            freeze_blocks_task_manager: true,
            unlock_text_length: 120,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DayStats {
    /// Seconds spent with at least one block active.
    pub focus_seconds: u64,
    /// Number of times a blocked app was closed.
    pub blocked_launches: u32,
    /// Completed pomodoro focus rounds.
    pub pomodoros: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub version: u32,
    pub categories: Vec<Category>,
    pub lists: Vec<BlockList>,
    pub schedules: Vec<Schedule>,
    pub sessions: Vec<Session>,
    pub pomodoro: Option<Pomodoro>,
    pub freeze: Option<Freeze>,
    pub settings: Settings,
    /// Keyed by local date `YYYY-MM-DD`.
    pub stats: BTreeMap<String, DayStats>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            categories: default_categories(),
            lists: vec![
                BlockList {
                    id: "social".into(),
                    name: "Social Media".into(),
                    color: "#8b5cf6".into(),
                    icon: "💬".into(),
                    sites: vec![],
                    apps: vec![],
                    categories: vec!["social".into()],
                },
                BlockList {
                    id: "video".into(),
                    name: "Video & Streaming".into(),
                    color: "#ef4444".into(),
                    icon: "📺".into(),
                    sites: vec![],
                    apps: vec![],
                    categories: vec!["video".into()],
                },
                BlockList {
                    id: "games".into(),
                    name: "Games".into(),
                    color: "#10b981".into(),
                    icon: "🎮".into(),
                    sites: vec![],
                    apps: vec![],
                    categories: vec!["gaming".into()],
                },
            ],
            schedules: vec![],
            sessions: vec![],
            pomodoro: None,
            freeze: None,
            settings: Settings::default(),
            stats: BTreeMap::new(),
        }
    }
}

impl State {
    pub fn list(&self, id: &str) -> Option<&BlockList> {
        self.lists.iter().find(|l| l.id == id)
    }

    pub fn category(&self, id: &str) -> Option<&Category> {
        self.categories.iter().find(|c| c.id == id)
    }
}
