// Thin wrapper over Tauri commands. When the UI runs in a normal browser
// (`npm run dev`) it falls back to an in-memory mock so the UI can be
// developed and previewed without the native backend.

import type {
  BlockList,
  Category,
  InstalledApp,
  LockMode,
  PomodoroConfig,
  Schedule,
  Settings,
  Snapshot,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Args = Record<string, unknown>;

async function call<T>(cmd: string, args?: Args): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  const { mockInvoke } = await import("./mock");
  return mockInvoke(cmd, args) as Promise<T>;
}

export function onSnapshot(cb: (s: Snapshot) => void): () => void {
  if (isTauri) {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<Snapshot>("snapshot", (e) => cb(e.payload)).then((u) => {
        if (cancelled) u();
        else unlisten = u;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }
  let off = () => {};
  import("./mock").then(({ mockSubscribe }) => {
    off = mockSubscribe(cb);
  });
  return () => off();
}

export const api = {
  snapshot: () => call<Snapshot>("get_snapshot"),
  saveList: (list: BlockList) => call<Snapshot>("save_list", { list }),
  deleteList: (id: string) => call<Snapshot>("delete_list", { id }),
  saveCategory: (category: Category) => call<Snapshot>("save_category", { category }),
  deleteCategory: (id: string) => call<Snapshot>("delete_category", { id }),
  saveSchedule: (schedule: Schedule) => call<Snapshot>("save_schedule", { schedule }),
  deleteSchedule: (id: string) => call<Snapshot>("delete_schedule", { id }),
  startSession: (listId: string, minutes: number, lock: LockMode) =>
    call<Snapshot>("start_session", { listId, minutes, lock }),
  extendSession: (id: string, minutes: number) => call<Snapshot>("extend_session", { id, minutes }),
  unlockChallenge: (id: string) => call<string>("unlock_challenge", { id }),
  stopSession: (id: string, answer?: string) => call<Snapshot>("stop_session", { id, answer }),
  pomodoroStart: (config: PomodoroConfig) => call<Snapshot>("pomodoro_start", { config }),
  pomodoroPause: () => call<Snapshot>("pomodoro_pause"),
  pomodoroResume: () => call<Snapshot>("pomodoro_resume"),
  pomodoroSkip: () => call<Snapshot>("pomodoro_skip"),
  pomodoroStop: () => call<Snapshot>("pomodoro_stop"),
  startFreeze: (minutes: number, message: string) => call<Snapshot>("start_freeze", { minutes, message }),
  saveSettings: (settings: Settings) => call<Snapshot>("save_settings", { settings }),
  installedApps: () => call<InstalledApp[]>("installed_apps"),
  appIcon: (path: string) => call<string | null>("app_icon", { path }),
  getAutostart: () => call<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => call<boolean>("set_autostart", { enabled }),
  relaunchAsAdmin: () => call<void>("relaunch_as_admin"),
};
