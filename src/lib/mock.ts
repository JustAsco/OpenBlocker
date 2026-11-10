// Browser-only stand-in for the Rust backend, used by `npm run dev` outside
// of Tauri. It mimics the command semantics closely enough to design the UI;
// it does not block anything.

import type { InstalledApp, PomodoroConfig, Pomodoro, Snapshot, State } from "./types";
import { defaultCategories } from "./catalog";
import { activeBlocks, dateKey, listTargets, MINUTE, normalizeDomain, uid } from "./util";

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
    version: 1,
    categories: defaultCategories(),
    lists: [
      { id: "social", name: "Social Media", color: "#8b5cf6", icon: "💬", sites: [], apps: [], categories: ["social"] },
      { id: "video", name: "Video & Streaming", color: "#ef4444", icon: "📺", sites: [], apps: [], categories: ["video"] },
      { id: "games", name: "Games", color: "#10b981", icon: "🎮", sites: [], apps: [], categories: ["gaming"] },
    ],
    schedules: [
      { id: "s1", listId: "social", days: [0, 1, 2, 3, 4], start: 9 * 60, end: 17 * 60, locked: false, label: "Work hours" },
      { id: "s2", listId: "games", days: [0, 1, 2, 3, 6], start: 22 * 60, end: 7 * 60, locked: true, label: "Sleep" },
      { id: "s3", listId: "video", days: [0, 2, 4], start: 13 * 60, end: 15 * 60 + 30, locked: false, label: "Deep work" },
    ],
    sessions: [],
    pomodoro: null,
    freeze: null,
    settings: {
      flushDns: true,
      notifications: true,
      closeToTray: true,
      blockSubdomains: true,
      freezeBlocksTaskManager: true,
      unlockTextLength: 120,
    },
    stats,
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return defaultState();
}

let state = load();
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
  const active = activeBlocks(state);
  const ids = new Set(active.map((a) => a.listId));
  const sites = new Set<string>();
  const apps = new Set<string>();
  for (const l of state.lists.filter((l) => ids.has(l.id))) {
    const t = listTargets(state, l);
    t.sites.forEach((x) => sites.add(x));
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
      elevated: true,
      platform: "browser-preview",
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
      const list = { ...a.list, sites: [...new Set<string>(a.list.sites.map(normalizeDomain).filter(Boolean))] };
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
      const c = { ...a.category, sites: [...new Set<string>(a.category.sites.map(normalizeDomain).filter(Boolean))] };
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
    case "start_session":
      state.sessions.push({ id: uid(), listId: a.listId, startedAt: now, endsAt: now + a.minutes * MINUTE, lock: a.lock });
      return commit();
    case "extend_session":
      state.sessions = state.sessions.map((s) => (s.id === a.id ? { ...s, endsAt: s.endsAt + a.minutes * MINUTE } : s));
      return commit();
    case "unlock_challenge": {
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
    case "relaunch_as_admin":
      return;
  }
  fail(`unknown command ${cmd}`);
}
