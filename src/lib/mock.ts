// Browser-only stand-in for the Rust backend, used by `npm run dev` outside
// of Tauri. It mimics the command semantics closely enough to design the UI;
// it does not block anything.

import type { InstalledApp, PomodoroConfig, Pomodoro, Snapshot, State } from "./types";
import { defaultCategories } from "./catalog";
import { activeBlocks, dateKey, listTargets, MINUTE, normalizeChannel, normalizeSite, uid } from "./util";

const KEY = "openblocker-mock-state-v2";

function defaultState(): State {
  const today = new Date();
  const stats: State["stats"] = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    stats[dateKey(d)] = {
      focusSeconds: Math.round((1.5 + Math.abs(Math.sin(i * 1.7)) * 4) * 3600),
      blockedLaunches: Math.round(Math.abs(Math.cos(i)) * 9),
      pomodoros: Math.round(Math.abs(Math.sin(i + 1)) * 8),
    };
  }
  return {
    version: 2,
    categories: defaultCategories(),
    lists: [
      { id: "social", name: "Social Media", color: "#8b5cf6", icon: "💬", sites: [], apps: [], categories: ["social"], mode: "block" },
      { id: "video", name: "Video & Streaming", color: "#ef4444", icon: "📺", sites: [], apps: [], categories: ["video"], mode: "block" },
      { id: "games", name: "Games", color: "#10b981", icon: "🎮", sites: [], apps: [], categories: ["gaming"], mode: "block" },
    ],
    schedules: [
      { id: "s1", listId: "social", days: [0, 1, 2, 3, 4], start: 9 * 60, end: 17 * 60, locked: false, label: "Work hours" },
      { id: "s2", listId: "games", days: [0, 1, 2, 3, 6], start: 22 * 60, end: 7 * 60, locked: true, label: "Sleep" },
      { id: "s3", listId: "video", days: [0, 2, 4], start: 13 * 60, end: 15 * 60 + 30, locked: false, label: "Deep work" },
    ],
    sessions: [],
    pomodoro: null,
    freeze: null,
    limits: [{ id: "l1", listId: "video", minutes: 45, days: [0, 1, 2, 3, 4, 5, 6], locked: false }],
    settings: {
      flushDns: true,
      notifications: true,
      closeToTray: true,
      blockSubdomains: true,
      freezeBlocksTaskManager: true,
      unlockTextLength: 120,
      requireExtension: false,
      suggestExtension: true,
      hideShortVideoFeeds: true,
      unlockTextStyle: "random",
    },
    stats,
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      s.settings = { ...defaultState().settings, ...s.settings };
      s.limits ??= [];
      // Mirrors the core's migration: new built-in categories appear once.
      if ((s.version ?? 1) < 2) {
        for (const c of defaultCategories()) if (c.id === "shorts" && !s.categories.some((x) => x.id === c.id)) s.categories.push(c);
        s.version = 2;
      }
      return s;
    }
  } catch {
    /* ignore */
  }
  return defaultState();
}

let state = load();
const mockPassword = () => localStorage.getItem("mock-password");
/** Seconds used today per limit (the real app measures this; the mock fakes some). */
const usage: Record<string, number> = { l1: 31 * 60 };
const challenges = new Map<string, string>();
const subs = new Set<(s: Snapshot) => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function snapshot(): Snapshot {
  const active = activeBlocks(state, Date.now(), usage);
  const ids = new Set(active.map((a) => a.listId));
  const sites = new Set<string>();
  const apps = new Set<string>();
  let allowed: Set<string> | null = null;
  for (const l of state.lists.filter((l) => ids.has(l.id))) {
    const t = listTargets(state, l);
    if (l.mode === "allow") {
      allowed ??= new Set();
      t.sites.forEach((x) => allowed!.add(x));
    } else t.sites.forEach((x) => sites.add(x));
    t.apps.forEach((_, k) => apps.add(k));
  }
  return {
    state: structuredClone(state),
    status: {
      now: Date.now(),
      active,
      blockedSites: sites.size,
      blockedApps: apps.size,
      hostsError: null,
      elevated: false,
      // localStorage "mock-service" = "0" previews the app without the background service.
      service: localStorage.getItem("mock-service") !== "0",
      platform: "browser-preview",
      // localStorage "mock-extension" = "0" previews the app without a connected extension.
      extension: localStorage.getItem("mock-extension") === "0" ? [] : [{ exe: "chrome.exe", name: "Google Chrome", lastSeen: Date.now(), extensionVersion: "0.1.0" }],
      extensionRequired: allowed !== null || (state.settings.requireExtension && sites.size > 0),
      allowlistSites: allowed ? (allowed as Set<string>).size : null,
      bridgeError: null,
      usageToday: { ...usage },
      passwordSet: !!mockPassword(),
    },
  };
}

function commit(): Snapshot {
  persist();
  const s = snapshot();
  subs.forEach((cb) => cb(s));
  return s;
}

const lockedUntil = (listId: string) =>
  activeBlocks(state)
    .filter((b) => b.listId === listId && b.locked)
    .reduce<number | null>((m, b) => Math.max(m ?? 0, b.endsAt), null);

function phaseMs(c: PomodoroConfig, phase: Pomodoro["phase"]) {
  return (phase === "focus" ? c.focusMin : phase === "break" ? c.breakMin : c.longBreakMin) * MINUTE;
}

function advance(p: Pomodoro, now: number): Pomodoro | null {
  const next = { ...p };
  if (p.phase === "focus") {
    const k = dateKey(new Date());
    state.stats[k] ??= { focusSeconds: 0, blockedLaunches: 0, pomodoros: 0 };
    state.stats[k].pomodoros++;
    if (p.config.totalRounds && p.round >= p.config.totalRounds) return null;
    next.phase = p.round % Math.max(1, p.config.rounds) === 0 ? "longBreak" : "break";
  } else {
    next.phase = "focus";
    next.round++;
  }
  next.phaseStartedAt = now;
  next.phaseEndsAt = now + phaseMs(p.config, next.phase);
  next.pausedRemaining = null;
  return next;
}

function fail(msg: string): never {
  throw msg;
}

setInterval(() => {
  const now = Date.now();
  state.sessions = state.sessions.filter((s) => s.endsAt > now);
  if (state.pomodoro && state.pomodoro.pausedRemaining === null && now >= state.pomodoro.phaseEndsAt)
    state.pomodoro = advance(state.pomodoro, now);
  if (state.freeze && state.freeze.endsAt <= now) state.freeze = null;
  if (activeBlocks(state).length) {
    const k = dateKey(new Date());
    state.stats[k] ??= { focusSeconds: 0, blockedLaunches: 0, pomodoros: 0 };
    state.stats[k].focusSeconds++;
  }
  commit();
}, 1000);

export function mockSubscribe(cb: (s: Snapshot) => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const FAKE_APPS: InstalledApp[] = [
  { name: "Discord", exe: "Discord.exe", path: null, running: true },
  { name: "Spotify", exe: "Spotify.exe", path: null, running: true },
  { name: "Steam", exe: "steam.exe", path: null, running: false },
  { name: "Visual Studio Code", exe: "Code.exe", path: null, running: true },
  { name: "Obsidian", exe: "Obsidian.exe", path: null, running: false },
  { name: "League of Legends", exe: "LeagueClient.exe", path: null, running: false },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mockInvoke(cmd: string, a: any = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 30));
  const now = Date.now();
  switch (cmd) {
    case "get_snapshot":
      return snapshot();
    case "save_list": {
      const list = {
        ...a.list,
        sites: [...new Set<string>(a.list.sites.map(normalizeSite).filter(Boolean))],
        exceptSites: [...new Set<string>((a.list.exceptSites ?? []).map(normalizeSite).filter(Boolean))],
        youtubeChannels: [...new Set<string>((a.list.youtubeChannels ?? []).map(normalizeChannel).filter(Boolean))],
      };
      const old = state.lists.find((l) => l.id === list.id);
      if (old) {
        const until = lockedUntil(list.id);
        if (until && (!old.sites.every((s) => list.sites.includes(s)) || !old.categories.every((c) => list.categories.includes(c))))
          fail(`“${old.name}” is locked until ${new Date(until).toLocaleTimeString()}. You can add items, but not remove them.`);
        state.lists = state.lists.map((l) => (l.id === list.id ? list : l));
      } else state.lists.push({ ...list, id: list.id || uid() });
      return commit();
    }
    case "delete_list":
      if (lockedUntil(a.id)) fail("This list is locked right now.");
      state.lists = state.lists.filter((l) => l.id !== a.id);
      state.schedules = state.schedules.filter((s) => s.listId !== a.id);
      state.sessions = state.sessions.filter((s) => s.listId !== a.id);
      return commit();
    case "save_category": {
      const c = { ...a.category, sites: [...new Set<string>(a.category.sites.map(normalizeSite).filter(Boolean))] };
      const old = state.categories.find((x) => x.id === c.id);
      if (old) {
        const until = state.lists.filter((l) => l.categories.includes(c.id)).map((l) => lockedUntil(l.id)).find(Boolean);
        if (until && !old.sites.every((x) => c.sites.includes(x)))
          fail(`“${old.name}” is used by a locked block. You can add items, but not remove them.`);
        state.categories = state.categories.map((x) => (x.id === c.id ? c : x));
      } else state.categories.push({ ...c, id: c.id || uid() });
      return commit();
    }
    case "delete_category":
      if (state.lists.some((l) => l.categories.includes(a.id) && lockedUntil(l.id))) fail("This category is used by a locked block.");
      state.categories = state.categories.filter((c) => c.id !== a.id);
      state.lists = state.lists.map((l) => ({ ...l, categories: l.categories.filter((c) => c !== a.id) }));
      return commit();
    case "save_schedule": {
      const s = { ...a.schedule, id: a.schedule.id || uid() };
      if (!s.days.length) fail("Pick at least one day.");
      const running = activeBlocks(state).find((b) => b.refId === s.id && b.locked);
      if (running) fail("This schedule is locked and running.");
      const i = state.schedules.findIndex((x) => x.id === s.id);
      if (i >= 0) state.schedules[i] = s;
      else state.schedules.push(s);
      return commit();
    }
    case "delete_schedule":
      if (activeBlocks(state).find((b) => b.refId === a.id && b.locked)) fail("This schedule is locked and running.");
      state.schedules = state.schedules.filter((s) => s.id !== a.id);
      return commit();
    case "start_session": {
      const ends = now + a.minutes * MINUTE;
      const existing = state.sessions.find((s) => s.listId === a.listId && s.endsAt > now);
      const rank = { none: 0, text: 1, password: 2, timer: 3 } as const;
      if (existing) {
        existing.endsAt = Math.max(existing.endsAt, ends);
        if (rank[a.lock as keyof typeof rank] > rank[existing.lock]) existing.lock = a.lock;
      } else state.sessions.push({ id: uid(), listId: a.listId, startedAt: now, endsAt: ends, lock: a.lock });
      return commit();
    }
    case "extend_session":
      state.sessions = state.sessions.map((s) => (s.id === a.id ? { ...s, endsAt: s.endsAt + a.minutes * MINUTE } : s));
      return commit();
    case "unlock_challenge": {
      if (!challenges.has(a.id) && state.settings.unlockTextStyle === "reflection") {
        // The real texts live in the core (texts.rs); the mock shows a sample.
        const s = state.sessions.find((x) => x.id === a.id);
        const list = state.lists.find((l) => l.id === s?.listId)?.name ?? "this list";
        const left = Math.max(1, Math.round(((s?.endsAt ?? now) - now) / MINUTE));
        challenges.set(
          a.id,
          `I am about to unlock ${list} with ${left} minutes left. Nothing in there is urgent. It will all still be there later, and so will the reasons I blocked it. This urge feels important, but urges fade in a few minutes if I wait. I could just let it pass.`,
        );
      }
      if (!challenges.has(a.id)) {
        const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        challenges.set(a.id, Array.from({ length: state.settings.unlockTextLength }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
      }
      return challenges.get(a.id);
    }
    case "stop_session": {
      const s = state.sessions.find((x) => x.id === a.id) ?? fail("Session not found.");
      if (s.lock === "timer") fail(`Locked until ${new Date(s.endsAt).toLocaleTimeString()}. Stay strong 💪`);
      if (s.lock === "text" && a.answer !== challenges.get(a.id)) fail("The text doesn't match.");
      if (s.lock === "password" && a.answer !== mockPassword()) fail("Wrong password.");
      state.sessions = state.sessions.filter((x) => x.id !== a.id);
      return commit();
    }
    case "pomodoro_start":
      state.pomodoro = { config: a.config, phase: "focus", round: 1, phaseStartedAt: now, phaseEndsAt: now + a.config.focusMin * MINUTE, pausedRemaining: null };
      return commit();
    case "pomodoro_pause":
    case "pomodoro_skip":
    case "pomodoro_stop": {
      const p = state.pomodoro ?? fail("No pomodoro running.");
      if (p.config.locked && p.phase === "focus") fail("This focus session is locked. You can do it!");
      if (cmd === "pomodoro_pause") p.pausedRemaining ??= Math.max(0, p.phaseEndsAt - now);
      if (cmd === "pomodoro_skip") state.pomodoro = advance(p, now);
      if (cmd === "pomodoro_stop") state.pomodoro = null;
      return commit();
    }
    case "pomodoro_resume": {
      const p = state.pomodoro ?? fail("No pomodoro running.");
      if (p.pausedRemaining !== null) {
        p.phaseEndsAt = now + p.pausedRemaining;
        p.pausedRemaining = null;
      }
      return commit();
    }
    case "start_freeze":
      state.freeze = { startedAt: now, endsAt: now + a.minutes * MINUTE, message: a.message };
      return commit();
    case "save_settings":
      state.settings = a.settings;
      return commit();
    case "installed_apps":
      return FAKE_APPS;
    case "app_icon":
      return null;
    case "get_autostart":
      return localStorage.getItem("mock-autostart") === "1";
    case "set_autostart":
      localStorage.setItem("mock-autostart", a.enabled ? "1" : "0");
      return a.enabled;
    case "extension_path":
      return "C:\\Program Files\\OpenBlocker\\extension";
    case "open_extension_folder":
      return;
    case "relaunch_as_admin":
      return;
    case "set_password": {
      const cur = mockPassword();
      if (cur && a.current !== cur) fail("Wrong password.");
      if (!a.new && state.sessions.some((s) => s.lock === "password" && s.endsAt > now)) fail("A password-locked block is running. You can remove the password once it ends.");
      if (a.new && a.new.length < 4) fail("Use at least 4 characters.");
      // The mock keeps it in plain text; the real app stores an Argon2 hash.
      if (a.new) localStorage.setItem("mock-password", a.new);
      else localStorage.removeItem("mock-password");
      return commit();
    }
    case "save_limit": {
      const l = { ...a.limit, id: a.limit.id || uid() };
      if (!l.days.length) fail("Pick at least one day.");
      const i = state.limits.findIndex((x) => x.id === l.id);
      if (i >= 0) {
        const old = state.limits[i];
        if (old.locked && activeBlocks(state, now, usage).some((b) => b.refId === old.id) && (l.minutes > old.minutes || !l.locked))
          fail("This limit is used up and locked until midnight.");
        state.limits[i] = l;
      } else state.limits.push(l);
      return commit();
    }
    case "delete_limit":
      if (activeBlocks(state, now, usage).some((b) => b.refId === a.id && b.locked)) fail("This limit is used up and locked until midnight.");
      state.limits = state.limits.filter((l) => l.id !== a.id);
      return commit();
    case "set_category_source": {
      const domains = new Set<string>();
      for (const line of String(a.text).split("\n")) {
        const t = line.split("#")[0].trim().split(/\s+/);
        const d = normalizeSite(t.length > 1 ? t[1] : t[0]);
        if (d && !d.includes("/") && d !== "localhost") domains.add(d);
      }
      if (!domains.size) fail("No websites found in that list.");
      state.categories = state.categories.map((c) =>
        c.id === a.id ? { ...c, source: { url: a.url, name: a.name, updatedAt: now, count: domains.size } } : c,
      );
      return commit();
    }
    case "remove_category_source":
      state.categories = state.categories.map((c) => (c.id === a.id ? { ...c, source: null } : c));
      return commit();
    case "mock_export":
      return JSON.stringify(
        { app: "OpenBlocker", format: 1, exportedAt: now, categories: state.categories, lists: state.lists, schedules: state.schedules, settings: state.settings, limits: state.limits },
        null,
        2,
      );
    case "mock_import": {
      let b;
      try {
        b = JSON.parse(a.text);
      } catch {
        fail("This isn't a valid OpenBlocker settings file.");
      }
      if (b?.app !== "OpenBlocker") fail("This isn't an OpenBlocker settings file.");
      if (activeBlocks(state).some((x) => x.locked)) fail("A locked block is running. You can import settings once it ends.");
      const ids = new Set<string>(b.lists.map((l: { id: string }) => l.id));
      Object.assign(state, {
        categories: b.categories,
        lists: b.lists,
        schedules: b.schedules.filter((s: { listId: string }) => ids.has(s.listId)),
        limits: (b.limits ?? []).filter((l: { listId: string }) => ids.has(l.listId)),
        sessions: state.sessions.filter((s) => ids.has(s.listId)),
        settings: { ...state.settings, ...b.settings },
      });
      return commit();
    }
    case "reset_challenge": {
      if (!state.freeze && !activeBlocks(state).some((x) => x.locked)) return null;
      if (!challenges.has("__reset__")) {
        const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const len = Math.min(1000, Math.max(300, state.settings.unlockTextLength * 3));
        challenges.set("__reset__", Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
      }
      return challenges.get("__reset__");
    }
    case "factory_reset": {
      if ((state.freeze || activeBlocks(state).some((x) => x.locked)) && a.answer !== challenges.get("__reset__")) fail("The text doesn't match.");
      state = { ...defaultState(), schedules: [], limits: [], stats: state.stats };
      challenges.clear();
      return commit();
    }
  }
  fail(`unknown command ${cmd}`);
}
