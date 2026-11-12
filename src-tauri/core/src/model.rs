//! Persisted data model. Everything here is serialised as camelCase JSON and
//! mirrored in `src/lib/types.ts` on the frontend.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

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
    /// Block the listed sites, or (allowlist) allow *only* them in browsers.
    #[serde(default)]
    pub mode: ListMode,
    /// If not empty: while this list is active, YouTube videos only play from
    /// these channels (normalised with [`crate::hosts::normalize_channel`]).
    #[serde(default)]
    pub youtube_channels: Vec<String>,
    /// Websites left out of this list even though a category includes them,
    /// e.g. `facebook.com` in "all social media except Facebook". A path
    /// (`reddit.com/r/rust`) stays reachable while the rest of its site is
    /// blocked (needs the browser extension).
    #[serde(default)]
    pub except_sites: Vec<String>,
    /// Apps left out of this list even though a category includes them.
    #[serde(default)]
    pub except_apps: Vec<AppEntry>,
    /// Block the listed apps, or (allowlist) allow *only* them: any other
    /// program brought to the front is closed while the list is active.
    #[serde(default)]
    pub app_mode: ListMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ListMode {
    /// The list's websites are blocked.
    #[default]
    Block,
    /// Only the list's websites may be opened in browsers (needs the extension).
    /// Apps in the list are still blocked.
    Allow,
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
    /// A community domain list this category also includes. The (often very
    /// many) domains are stored in a separate file, not in the state.
    #[serde(default)]
    pub source: Option<CategorySource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySource {
    pub url: String,
    /// Display name, e.g. "StevenBlack · Adult".
    pub name: String,
    /// Unix ms of the last successful download.
    pub updated_at: i64,
    /// Number of domains in the downloaded list.
    pub count: usize,
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
            source: None,
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
    /// When locked: the unlock password can still end it early.
    #[serde(default)]
    pub password: bool,
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
    /// Requires the account password (often set by someone you trust).
    Password,
    /// Cannot be stopped until the timer runs out.
    Timer,
}

/// "At most N minutes per day": time spent on a list's websites and apps is
/// counted, and once the limit is used up the list is blocked until midnight.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    pub id: String,
    pub list_id: String,
    /// Allowed minutes per day.
    pub minutes: u32,
    /// Days the limit applies (0 = Monday … 6 = Sunday); other days are unlimited.
    pub days: Vec<u8>,
    /// Once used up, the block can't be stopped and the limit can't be raised
    /// or removed until midnight.
    #[serde(default)]
    pub locked: bool,
    /// When locked: the unlock password can still end the block early.
    #[serde(default)]
    pub password: bool,
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
    /// When locked: the unlock password can still stop it early.
    #[serde(default)]
    pub password: bool,
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
            password: false,
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

/// A schedule or usage limit that was ended early (with the password, or
/// because it wasn't locked): it stays off until `until`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skip {
    /// Id of the schedule or limit.
    pub ref_id: String,
    /// Unix ms; the block's planned end.
    pub until: i64,
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
    /// While websites are blocked, close browsers in which the OpenBlocker
    /// extension isn't running. (Always on while an allowlist is active.)
    pub require_extension: bool,
    /// When a website block starts and no browser has the extension, suggest
    /// installing it. Blocking via the hosts file works either way.
    pub suggest_extension: bool,
    /// While Shorts/Reels are blocked, also hide them in feeds (extension).
    pub hide_short_video_feeds: bool,
    /// What to type for "Type to unlock".
    pub unlock_text_style: UnlockTextStyle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UnlockTextStyle {
    /// Random letters and digits.
    #[default]
    Random,
    /// Sentences that make you think about why you want to stop early.
    Reflection,
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
            require_extension: false,
            suggest_extension: true,
            hide_short_video_feeds: true,
            unlock_text_style: UnlockTextStyle::Random,
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
    pub limits: Vec<UsageLimit>,
    /// Seconds used per limit id, keyed by local date `YYYY-MM-DD`.
    pub usage: BTreeMap<String, BTreeMap<String, u64>>,
    /// Hash (Argon2 PHC string) of the unlock password, if one is set. Only
    /// changed through its own command, which checks the current password.
    pub password: Option<String>,
    /// Schedules and limits that were ended early.
    pub skips: Vec<Skip>,
    /// Domains of each category's community list (normalised), loaded from
    /// their own files. Never serialised.
    #[serde(skip)]
    pub source_sites: BTreeMap<String, Arc<BTreeSet<String>>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
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
                    mode: ListMode::Block,
                    youtube_channels: vec![],
                    except_sites: vec![],
                    except_apps: vec![],
                    app_mode: ListMode::Block,
                },
                BlockList {
                    id: "video".into(),
                    name: "Video & Streaming".into(),
                    color: "#ef4444".into(),
                    icon: "📺".into(),
                    sites: vec![],
                    apps: vec![],
                    categories: vec!["video".into()],
                    mode: ListMode::Block,
                    youtube_channels: vec![],
                    except_sites: vec![],
                    except_apps: vec![],
                    app_mode: ListMode::Block,
                },
                BlockList {
                    id: "games".into(),
                    name: "Games".into(),
                    color: "#10b981".into(),
                    icon: "🎮".into(),
                    sites: vec![],
                    apps: vec![],
                    categories: vec!["gaming".into()],
                    mode: ListMode::Block,
                    youtube_channels: vec![],
                    except_sites: vec![],
                    except_apps: vec![],
                    app_mode: ListMode::Block,
                },
            ],
            schedules: vec![],
            sessions: vec![],
            pomodoro: None,
            freeze: None,
            settings: Settings::default(),
            stats: BTreeMap::new(),
            limits: vec![],
            usage: BTreeMap::new(),
            password: None,
            skips: vec![],
            source_sites: BTreeMap::new(),
        }
    }
}

/// Current data version, see [`State::migrate`].
pub const STATE_VERSION: u32 = 2;

/// Built-in categories added after the first release, with the data version
/// that introduced them. Existing installs get them once.
const ADDED_CATEGORIES: &[(u32, &str)] = &[(2, "shorts")];

impl State {
    /// Upgrades data saved by an older version. Safe to call repeatedly.
    pub fn migrate(&mut self) {
        if self.version < STATE_VERSION {
            for (since, id) in ADDED_CATEGORIES {
                if self.version < *since && self.category(id).is_none() {
                    if let Some(c) = default_categories().into_iter().find(|c| c.id == *id) {
                        self.categories.push(c);
                    }
                }
            }
            self.version = STATE_VERSION;
        }
    }

    pub fn list(&self, id: &str) -> Option<&BlockList> {
        self.lists.iter().find(|l| l.id == id)
    }

    pub fn category(&self, id: &str) -> Option<&Category> {
        self.categories.iter().find(|c| c.id == id)
    }
}
