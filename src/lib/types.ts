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
  /** "block" the sites, or "allow" only them in browsers. */
  mode: ListMode;
  /** "block" the apps, or "allow" only them (any other program in front is closed). */
  appMode?: ListMode;
  /** If not empty: while active, YouTube videos only play from these channels ("@handle", "UC…" id). */
  youtubeChannels?: string[];
  /** While active, videos from channels the user is subscribed to play too (read by the extension). */
  youtubeSubscriptions?: boolean;
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
  /** When locked: the unlock password can still end the block early. */
  password: boolean;
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
  /** When locked: the unlock password can still end it early. */
  password: boolean;
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

/** Runs around the clock until turned off; never "timer"-locked. */
export interface PermanentBlock {
  id: string;
  listId: string;
  lock: LockMode;
  since: number;
}

export type PomodoroPhase = "focus" | "break" | "longBreak";

export interface PomodoroConfig {
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  rounds: number;
  listId: string | null;
  locked: boolean;
  /** When locked: the unlock password can still stop it early. */
  password: boolean;
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
  /** UI language ("en", "de"); "" = follow the system. */
  language: string;
  /** Without the extension: block whole sites (strict) or leave them open (lenient). */
  extensionFallback: "strict" | "lenient";
  /** Close browsers whose extension can't see private windows (default: with an opt-out). */
  privateWindows: "default" | "on" | "off";
  /** While any block runs, every browser must have the extension (else closed after 15 s). */
  superStrict: boolean;
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
  /** Schedules and limits ended early, until their planned end. */
  skips: { refId: string; until: number }[];
  permanent: PermanentBlock[];
}

export type Source = "session" | "schedule" | "pomodoro" | "limit" | "permanent";

export interface ActiveBlock {
  listId: string;
  source: Source;
  refId: string;
  endsAt: number;
  locked: boolean;
  /** Locked, but the unlock password can end it early. */
  password: boolean;
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
  /** The running blocks use features only the extension can enforce. */
  extensionFeatures: boolean;
  allowlistSites: number | null;
  bridgeError: string | null;
  /** Seconds used today per usage limit id. */
  usageToday: Record<string, number>;
  /** An unlock password is set. */
  passwordSet: boolean;
  /** Version of the extension shipped with the app. */
  extensionLatest?: string;
}

export interface BrowserSeen {
  exe: string;
  name: string;
  lastSeen: number;
  extensionVersion: string;
  /** The extension may run in private/incognito windows (null = unknown, older extension). */
  incognito?: boolean | null;
  /** Subscribed channels the extension read (-1 = not signed in / unreadable), when they're needed. */
  youtubeSubscriptions?: number | null;
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
