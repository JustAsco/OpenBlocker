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
}

/** Reusable, editable group of sites/apps that block lists include by reference. */
export interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  sites: string[];
  apps: AppEntry[];
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

export type LockMode = "none" | "text" | "timer";

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
}

export type Source = "session" | "schedule" | "pomodoro";

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
  elevated: boolean;
  platform: string;
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
