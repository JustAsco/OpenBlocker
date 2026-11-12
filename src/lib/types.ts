// Mirrors src-tauri/core/src/model.rs and the Snapshot in src-tauri/src/lib.rs.

export interface AppEntry {
  name: string;
  exe: string;
  path?: string | null;
}

export interface BlockList {
  id: string;
  name: string;
  color: string;
  icon: string;
  sites: string[];
  apps: AppEntry[];
  /** Included category ids. */
  categories: string[];
  /** "block" the sites, or "allow" only them in browsers (apps are always blocked). */
  mode: ListMode;
  /** If not empty: while active, YouTube videos only play from these channels ("@handle", "UC…" id). */
  youtubeChannels?: string[];
  /** Websites left out although a category includes them; a path stays reachable inside a blocked site. */
  exceptSites?: string[];
  /** Apps left out although a category includes them. */
  exceptApps?: AppEntry[];
}

export type ListMode = "block" | "allow";

/** Reusable, editable group of sites/apps that block lists include by reference. */
export interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  sites: string[];
  apps: AppEntry[];
  /** A community domain list included in this category (its domains live in a separate file). */
  source?: CategorySource | null;
}

export interface CategorySource {
  url: string;
  name: string;
  updatedAt: number;
  count: number;
}

/** "At most N minutes per day" for a block list. */
export interface UsageLimit {
  id: string;
  listId: string;
  minutes: number;
  /** 0 = Monday … 6 = Sunday */
  days: number[];
  locked: boolean;
}

export interface Schedule {
  id: string;
  listId: string;
  /** 0 = Monday … 6 = Sunday */
  days: number[];
  /** minutes since midnight */
  start: number;
  end: number;
  locked: boolean;
  label?: string | null;
}

export type LockMode = "none" | "text" | "password" | "timer";

export interface Session {
  id: string;
  listId: string;
  startedAt: number;
  endsAt: number;
  lock: LockMode;
}

export type PomodoroPhase = "focus" | "break" | "longBreak";

export interface PomodoroConfig {
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  rounds: number;
  listId: string | null;
  locked: boolean;
  totalRounds: number | null;
}

export interface Pomodoro {
  config: PomodoroConfig;
  phase: PomodoroPhase;
  round: number;
  phaseStartedAt: number;
  phaseEndsAt: number;
  pausedRemaining: number | null;
}

export interface Freeze {
  startedAt: number;
  endsAt: number;
  message: string;
}

export interface Settings {
  flushDns: boolean;
  notifications: boolean;
  closeToTray: boolean;
  blockSubdomains: boolean;
  freezeBlocksTaskManager: boolean;
  unlockTextLength: number;
  requireExtension: boolean;
  /** Suggest installing the extension when a website block starts without it. */
  suggestExtension: boolean;
  /** While Shorts/Reels are blocked, also hide them in feeds (extension). */
  hideShortVideoFeeds: boolean;
  /** "Type to unlock": random characters or reflection sentences. */
  unlockTextStyle: "random" | "reflection";
}

export interface DayStats {
  focusSeconds: number;
  blockedLaunches: number;
  pomodoros: number;
}

export interface State {
  version: number;
  categories: Category[];
  lists: BlockList[];
  schedules: Schedule[];
  sessions: Session[];
  pomodoro: Pomodoro | null;
  freeze: Freeze | null;
  settings: Settings;
  stats: Record<string, DayStats>;
  limits: UsageLimit[];
}

export type Source = "session" | "schedule" | "pomodoro" | "limit";

export interface ActiveBlock {
  listId: string;
  source: Source;
  refId: string;
  endsAt: number;
  locked: boolean;
}

export interface Status {
  now: number;
  active: ActiveBlock[];
  blockedSites: number;
  blockedApps: number;
  hostsError: string | null;
  /** The app itself may edit the hosts file. */
  elevated: boolean;
  /** The background service is running and enforcing. */
  service: boolean;
  platform: string;
  extension: BrowserSeen[];
  extensionRequired: boolean;
  allowlistSites: number | null;
  bridgeError: string | null;
  /** Seconds used today per usage limit id. */
  usageToday: Record<string, number>;
  /** An unlock password is set. */
  passwordSet: boolean;
}

export interface BrowserSeen {
  exe: string;
  name: string;
  lastSeen: number;
  extensionVersion: string;
}

export interface Snapshot {
  state: State;
  status: Status;
}

export interface InstalledApp {
  name: string;
  exe: string;
  path: string | null;
  running: boolean;
}
