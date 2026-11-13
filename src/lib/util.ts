import { language, t } from "./i18n";
import type { ActiveBlock, AppEntry, BlockList, Schedule, State } from "./types";

export const MINUTE = 60_000;
/** endsAt of permanent blocks (year 9999), as in model.rs. */
export const PERMANENT_END = 253_402_300_799_000;
// Weekday names in the UI language, Monday first (2024-01-01 was a Monday).
const weekdays = (style: "short" | "long") =>
  Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(language(), { weekday: style }));
export const DAYS = weekdays("short");
export const DAYS_LONG = weekdays("long");

/** 0 = Monday */
export const weekday = (d: Date) => (d.getDay() + 6) % 7;
export const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function fmtClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function parseClock(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** "1h 05m", "12m 30s", "45s" */
export function fmtDuration(ms: number, seconds = true): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${t("{n}d", { n: d })} ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return seconds ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
  return seconds ? `${s}s` : "<1m";
}

/** "25:00" style countdown */
export function fmtTimer(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(language(), { weekday: "short" })} ${time}`;
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Port of engine::schedule_remaining_ms. */
export function scheduleRemaining(s: Schedule, now: Date): number | null {
  const m = minuteOfDay(now);
  const d = weekday(now);
  const yesterday = (d + 6) % 7;
  const has = (x: number) => s.days.includes(x);
  let left: number;
  if (s.start === s.end) {
    if (!has(d)) return null;
    left = 1440 - m;
  } else if (s.start < s.end) {
    if (!(has(d) && s.start <= m && m < s.end)) return null;
    left = s.end - m;
  } else if (has(d) && m >= s.start) {
    left = 1440 - m + s.end;
  } else if (has(yesterday) && m < s.end) {
    left = s.end - m;
  } else return null;
  return left * MINUTE - (now.getSeconds() * 1000 + now.getMilliseconds());
}

/** Port of engine::active_blocks (used by the browser mock). */
/** Mirrors `active_blocks` in the core (used by the browser mock). `usage` = seconds used today per limit. */
export function activeBlocks(state: State, now = Date.now(), usage: Record<string, number> = {}): ActiveBlock[] {
  const out: ActiveBlock[] = [];
  for (const s of state.sessions)
    if (s.startedAt <= now && now < s.endsAt)
      out.push({ listId: s.listId, source: "session", refId: s.id, endsAt: s.endsAt, locked: s.lock !== "none", password: s.lock === "password" });
  for (const p of state.permanent ?? [])
    out.push({ listId: p.listId, source: "permanent", refId: p.id, endsAt: PERMANENT_END, locked: p.lock !== "none", password: p.lock === "password" });
  const date = new Date(now);
  for (const sch of state.schedules) {
    const left = scheduleRemaining(sch, date);
    if (left !== null)
      out.push({ listId: sch.listId, source: "schedule", refId: sch.id, endsAt: now + left, locked: sch.locked, password: sch.locked && !!sch.password });
  }
  const p = state.pomodoro;
  if (p && p.phase === "focus" && p.pausedRemaining === null && p.config.listId)
    out.push({ listId: p.config.listId, source: "pomodoro", refId: "pomodoro", endsAt: p.phaseEndsAt, locked: p.config.locked, password: p.config.locked && !!p.config.password });
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  for (const l of state.limits ?? [])
    if (l.days.includes(weekday(date)) && (usage[l.id] ?? 0) >= l.minutes * 60)
      out.push({ listId: l.listId, source: "limit", refId: l.id, endsAt: midnight.getTime(), locked: l.locked, password: l.locked && !!l.password });
  const skipped = (id: string) => (state.skips ?? []).some((s) => s.refId === id && now < s.until);
  return out.filter((b) => state.lists.some((l) => l.id === b.listId) && !skipped(b.refId));
}

/** Port of hosts::normalize_domain. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.split(/[/?#]/)[0];
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  s = s.split(":")[0];
  s = s.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "").replace(/^www\./, "");
  const ok =
    s.length > 0 &&
    s.length <= 253 &&
    s.includes(".") &&
    s.split(".").every((l) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-"));
  return ok ? s : null;
}

/**
 * Like normalizeDomain, but keeps the path so parts of a website can be
 * blocked: "https://www.youtube.com/shorts/?x" → "youtube.com/shorts".
 * Mirrors `normalize_site` in src-tauri/core/src/hosts.rs.
 */
export function normalizeSite(input: string): string | null {
  const s = input.trim().toLowerCase();
  const scheme = s.indexOf("://");
  const rest = scheme >= 0 ? s.slice(scheme + 3) : s;
  const slash = rest.indexOf("/");
  const hasPath = slash >= 0 && !/[?#]/.test(rest.slice(0, slash));
  const domain = normalizeDomain(hasPath ? rest.slice(0, slash) : rest);
  if (!domain) return null;
  const path = hasPath ? rest.slice(slash).split(/[?#]/)[0].replace(/\/+$/, "") : "";
  if (!path) return domain;
  if (/\s/.test(path) || path.includes("//")) return null;
  return domain + path;
}

/** Is this site entry only part of a website ("youtube.com/shorts")? */
/** Is version a older than b ("0.2.0" < "0.10.0")? */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

export const isPathSite = (site: string) => site.includes("/");

export function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const LIST_COLORS = ["#8b5cf6", "#06b6d4", "#ef4444", "#f59e0b", "#10b981", "#ec4899", "#3b82f6", "#f97316", "#14b8a6", "#a3a3a3"];
export const LIST_EMOJIS = ["💬", "📺", "🎮", "📰", "🛒", "🎵", "🔞", "🃏", "📱", "🌐", "🍿", "⚽", "💸", "🧠", "⛔", "🔥"];

/** Human duration from minutes: "15m", "1h", "1h 30m", "2d 3h". */
export function fmtMinutes(min: number): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = Math.round(min % 60);
  return [d && t("{n}d", { n: d }), h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "0m";
}

/** Everything a list blocks: its own items plus those of its categories. */
export function listTargets(state: State, list: BlockList): { sites: Set<string>; apps: Map<string, AppEntry> } {
  const sites = new Set<string>(list.sites);
  const apps = new Map<string, AppEntry>(list.apps.map((a) => [a.exe.toLowerCase(), a]));
  for (const id of list.categories ?? []) {
    const c = state.categories.find((x) => x.id === id);
    if (!c) continue;
    c.sites.forEach((x) => sites.add(x));
    c.apps.forEach((a) => apps.set(a.exe.toLowerCase(), a));
  }
  // Exceptions: a domain leaves out the whole site, a path just that part.
  for (const e of list.exceptSites ?? []) {
    for (const s of [...sites]) {
      const d = s.split("/")[0];
      if (isPathSite(e) ? s === e || s.startsWith(e + "/") : d === e || d.endsWith("." + e)) sites.delete(s);
    }
  }
  for (const a of list.exceptApps ?? []) apps.delete(a.exe.toLowerCase());
  return { sites, apps };
}

/**
 * Canonical YouTube channel reference: "@handle" (lowercase), "UC…" id, or
 * "c/name" / "user/name". Mirrors `normalize_channel` in the core.
 */
export function normalizeChannel(input: string): string | null {
  let s = input.trim();
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  const lower = s.toLowerCase();
  const host = ["www.youtube.com/", "m.youtube.com/", "youtube.com/", "music.youtube.com/"].find((p) => lower.startsWith(p));
  const wasUrl = !!host || scheme >= 0 || /[?#]/.test(s);
  if (host) s = s.slice(host.length);
  s = s.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  const ok = (t?: string): boolean => !!t && t.length <= 100 && /^[A-Za-z0-9._-]+$/.test(t);
  const isId = (t?: string): boolean => !!t && t.length === 24 && t.startsWith("UC") && ok(t);
  const first = parts[0] ?? "";
  if (first === "channel") return isId(parts[1]) ? parts[1]! : null;
  if (first === "c" || first === "user") return ok(parts[1]) ? `${first}/${parts[1]!.toLowerCase()}` : null;
  if (first.startsWith("@") && ok(first.slice(1))) return first.toLowerCase();
  if (isId(first)) return first;
  if (!wasUrl && !s.includes("/") && ok(first) && !first.includes(".")) return "@" + first.toLowerCase();
  return null;
}
