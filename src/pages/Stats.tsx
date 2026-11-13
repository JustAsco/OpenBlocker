import clsx from "clsx";
import { Ban, Clock, Flame, MonitorSmartphone, Target, Timer, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Page } from "../App";
import { AppIcon, PageHeader, Segmented, SiteIcon, usePref } from "../components/ui";
import { APPS, siteName } from "../lib/catalog";
import { language, t } from "../lib/i18n";
import { useStore } from "../lib/store";
import type { DayStats, State } from "../lib/types";
import { DAYS, dateKey, fmtDuration, listTargets, weekday } from "../lib/util";

type Range = 7 | 30 | 90;

interface Day {
  date: Date;
  key: string;
  s: DayStats | undefined;
}

/** "3h 45m", or whole hours for totals over a day ("338 h" reads better than "14d 2h"). */
const hours = (sec: number) => (sec >= 86_400 ? `${Math.round(sec / 3600)} h` : fmtDuration(sec * 1000, false));
const sumMap = (days: Day[], pick: (s: DayStats) => Record<string, number> | undefined) => {
  const out = new Map<string, number>();
  for (const d of days) for (const [k, v] of Object.entries((d.s && pick(d.s)) ?? {})) out.set(k, (out.get(k) ?? 0) + v);
  return [...out.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
};

/** Days with focus in a row, ending today (or yesterday, if today has none yet), and the longest run ever. */
function streaks(stats: State["stats"]) {
  let current = 0;
  const d = new Date();
  if (!(stats[dateKey(d)]?.focusSeconds > 0)) d.setDate(d.getDate() - 1);
  while ((stats[dateKey(d)]?.focusSeconds ?? 0) > 0) {
    current++;
    d.setDate(d.getDate() - 1);
  }
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of Object.keys(stats).sort()) {
    if (!(stats[key].focusSeconds > 0)) continue;
    const date = new Date(key + "T12:00:00");
    run = prev && Math.round((date.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = date;
  }
  return { current, longest: Math.max(longest, current) };
}

export function StatsPage({ go }: { go: (p: Page) => void }) {
  const { snap } = useStore();
  const state = snap!.state;
  const [range, setRange] = usePref<Range>("stats-range", 7);

  const days: Day[] = useMemo(() => {
    const out: Day[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = dateKey(date);
      out.push({ date, key, s: state.stats[key] });
    }
    return out;
  }, [range, state.stats]);

  const total = (f: (s: DayStats) => number | undefined) => days.reduce((n, d) => n + ((d.s && f(d.s)) ?? 0), 0);
  const focus = total((s) => s.focusSeconds);
  const daysWithFocus = days.filter((d) => (d.s?.focusSeconds ?? 0) > 0).length;
  const blocked = total((s) => s.blockedLaunches) + total((s) => Object.values(s.blockedSites ?? {}).reduce((a, b) => a + b, 0));
  const { current, longest } = useMemo(() => streaks(state.stats), [state.stats]);

  return (
    <>
      <PageHeader
        title={t("Statistics")}
        subtitle={t("Everything here is recorded on this PC only and never leaves it.")}
        actions={
          <Segmented<Range>
            value={range}
            onChange={setRange}
            options={[
              { value: 7, label: t("7 days") },
              { value: 30, label: t("30 days") },
              { value: 90, label: t("90 days") },
            ]}
          />
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile icon={Target} label={t("Focused")} value={hours(focus)} sub={t("{time} per day on average", { time: hours(focus / range) })} />
        <Tile icon={Flame} label={t("Streak")} value={t("{n} days", { n: current })} sub={t("Longest: {n} days", { n: longest })} />
        <Tile icon={Timer} label={t("Pomodoros")} value={String(total((s) => s.pomodoros))} sub={t("{n} days with focus time", { n: daysWithFocus })} />
        <Tile icon={Ban} label={t("Distractions stopped")} value={String(blocked)} sub={t("apps closed and sites blocked")} />
        <Tile icon={Undo2} label={t("Ended early")} value={String(total((s) => s.earlyStops))} sub={t("blocks stopped before their end")} />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-5">
        <section className="card p-6 xl:col-span-3">
          <h2 className="mb-1 font-semibold">{t("Focus time per day")}</h2>
          <p className="mb-5 text-xs text-muted">{t("Time with at least one block or focus round running.")}</p>
          <DayBars days={days} />
        </section>
        <section className="card p-6 xl:col-span-2">
          <h2 className="mb-1 font-semibold">{t("When you focus")}</h2>
          <p className="mb-5 text-xs text-muted">{t("Focus time by weekday and hour, over the selected days.")}</p>
          <Heatmap days={days} />
        </section>
      </div>

      <ScreenTime days={days} state={state} go={go} />

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-1 font-semibold">{t("Most closed apps")}</h2>
          <p className="mb-4 text-xs text-muted">{t("How often each program was closed because it was blocked.")}</p>
          <Ranked rows={sumMap(days, (s) => s.closedApps)} kind="app" unit="count" empty={t("No apps were closed in this period.")} />
        </section>
        <section className="card p-6">
          <h2 className="mb-1 font-semibold">{t("Most blocked websites")}</h2>
          <p className="mb-4 text-xs text-muted">{t("How often each website showed the block page (browsers with the extension).")}</p>
          <Ranked rows={sumMap(days, (s) => s.blockedSites)} kind="site" unit="count" empty={t("No block pages in this period.")} />
        </section>
      </div>
    </>
  );
}

function Tile({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: string; sub: string }) {
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted">
        <Icon size={14} /> {label}
      </div>
      <div className="font-display text-2xl font-semibold whitespace-nowrap tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-faint">{sub}</div>
    </div>
  );
}

/** Small floating label for the hovered mark. */
function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-xs whitespace-nowrap shadow-xl">
      {children}
    </div>
  );
}

function DayBars({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(3600, ...days.map((d) => d.s?.focusSeconds ?? 0));
  // Gridlines at whole hours, at most four of them.
  const step = Math.max(1, Math.ceil(max / 3600 / 4)) * 3600;
  const lines = Array.from({ length: Math.floor(max / step) }, (_, i) => (i + 1) * step);
  const labelEvery = days.length <= 7 ? 1 : days.length <= 30 ? 5 : 14;
  const fmtDay = (d: Date) => (days.length <= 7 ? DAYS[weekday(d)] : d.toLocaleDateString(language(), { day: "numeric", month: "short" }));

  return (
    <div>
      <div className="relative h-48">
        {lines.map((v) => (
          <div key={v} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${(v / max) * 100}%` }}>
            <span className="absolute -top-2 right-0 bg-card pl-1 text-[10px] text-faint tabular-nums">{v / 3600} h</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px] pr-8">
          {days.map((d, i) => {
            const v = d.s?.focusSeconds ?? 0;
            const isToday = i === days.length - 1;
            return (
              <div key={d.key} className="relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div
                  className={clsx("w-full rounded-t-[4px] transition-colors", isToday ? "bg-accent-2" : hover === i ? "bg-accent" : "bg-accent/70")}
                  style={{ height: v ? `max(3px, ${(v / max) * 100}%)` : 0 }}
                />
                {hover === i && (
                  <Tip>
                    <span className="text-muted">{d.date.toLocaleDateString(language(), { weekday: "short", day: "numeric", month: "short" })}</span>{" "}
                    <span className="font-medium tabular-nums">{v ? hours(v) : t("no focus time")}</span>
                    {(d.s?.pomodoros ?? 0) > 0 && <span className="text-muted"> · {t("{n} pomodoros", { n: d.s!.pomodoros })}</span>}
                  </Tip>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex gap-[2px] pr-8">
        {days.map((d, i) => (
          <div key={d.key} className={clsx("flex-1 text-center text-[10px] whitespace-nowrap", i === days.length - 1 ? "text-fg" : "text-faint")}>
            {(days.length - 1 - i) % labelEvery === 0 ? fmtDay(d.date) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  // grid[weekday][hour] = seconds
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const d of days) d.s?.focusHours?.forEach((v, h) => (g[weekday(d.date)][h] += v));
    return g;
  }, [days]);
  const max = Math.max(1, ...grid.flat());
  const hasData = grid.some((row) => row.some((v) => v > 0));
  if (!hasData) return <p className="py-10 text-center text-sm text-muted">{t("Focus time from now on shows up here by hour.")}</p>;

  return (
    <div>
      <div className="grid grid-cols-[32px_repeat(24,1fr)] gap-[2px]">
        {grid.map((row, wd) => (
          <div key={wd} className="contents">
            <div className="pr-1 text-right text-[10px] leading-[18px] text-faint">{DAYS[wd]}</div>
            {row.map((v, h) => (
              <div
                key={h}
                className="relative h-[18px] rounded-[3px]"
                style={{ background: v ? `color-mix(in srgb, var(--color-accent) ${12 + Math.round((v / max) * 88)}%, var(--color-panel))` : "var(--color-panel)" }}
                onMouseEnter={() => setHover([wd, h])}
                onMouseLeave={() => setHover(null)}
              >
                {hover?.[0] === wd && hover[1] === h && (
                  <Tip>
                    <span className="text-muted">
                      {DAYS[wd]} {String(h).padStart(2, "0")}:00–{String(h + 1).padStart(2, "0")}:00
                    </span>{" "}
                    <span className="font-medium tabular-nums">{v ? hours(v) : t("no focus time")}</span>
                  </Tip>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-[32px_repeat(24,1fr)] gap-[2px] text-[10px] text-faint">
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-center">
            {h % 6 === 0 ? h : ""}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-faint">
        {t("less")}
        {[12, 34, 56, 78, 100].map((p) => (
          <span key={p} className="size-3 rounded-[3px]" style={{ background: `color-mix(in srgb, var(--color-accent) ${p}%, var(--color-panel))` }} />
        ))}
        {t("more")}
      </div>
    </div>
  );
}

function ScreenTime({ days, state, go }: { days: Day[]; state: State; go: (p: Page) => void }) {
  const active = days.reduce((n, d) => n + (d.s?.activeSeconds ?? 0), 0);
  const distracted = days.reduce((n, d) => n + (d.s?.distractedSeconds ?? 0), 0);
  const apps = sumMap(days, (s) => s.apps);
  const sites = sumMap(days, (s) => s.sites);
  // What's in block lists, to tag entries as distractions.
  const blockedTargets = useMemo(() => {
    const sites = new Set<string>();
    const apps = new Set<string>();
    for (const l of state.lists.filter((l) => l.mode === "block")) {
      const tg = listTargets(state, l);
      tg.sites.forEach((s) => sites.add(s.split("/")[0]));
      tg.apps.forEach((_, k) => apps.add(k));
    }
    return { sites, apps };
  }, [state]);
  const isDistraction = (kind: "app" | "site", key: string) =>
    kind === "app" ? blockedTargets.apps.has(key) : [...blockedTargets.sites].some((d) => key === d || key.endsWith("." + d));

  if (!state.settings.recordScreenTime && !active) {
    return (
      <section className="card p-6">
        <h2 className="mb-1 flex items-center gap-2 font-semibold">
          <MonitorSmartphone size={18} className="text-muted" /> {t("Screen time")}
        </h2>
        <p className="text-sm text-muted">
          {t("Screen time isn't recorded.")}{" "}
          <button className="text-fg underline underline-offset-2" onClick={() => go("settings")}>
            {t("Turn it on in Settings")}
          </button>
        </p>
      </section>
    );
  }

  const share = active ? Math.round((distracted / active) * 100) : 0;
  return (
    <section className="card p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <MonitorSmartphone size={18} className="text-accent-2" /> {t("Screen time")}
          </h2>
          <p className="text-xs text-muted">{t("Time at the computer while OpenBlocker runs; websites only in browsers with the extension.")}</p>
        </div>
        {active > 0 && (
          <div className="flex gap-6">
            <div>
              <div className="font-display text-2xl font-semibold tabular-nums">{hours(active)}</div>
              <div className="text-xs text-muted">{t("{time} per day on average", { time: hours(active / days.length) })}</div>
            </div>
            <div>
              <div className="font-display text-2xl font-semibold tabular-nums">{share}%</div>
              <div className="text-xs text-muted">{t("on things in your block lists ({time})", { time: hours(distracted) })}</div>
            </div>
          </div>
        )}
      </div>
      {active > 0 && (
        <div className="mb-6 h-2 overflow-hidden rounded-full bg-elevated" title={t("{n}% on things in your block lists", { n: share })}>
          <div className="h-full rounded-full bg-warn" style={{ width: `${share}%` }} />
        </div>
      )}
      {active ? (
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <h3 className="mb-3 text-sm font-medium">{t("Programs")}</h3>
            <Ranked rows={apps} kind="app" unit="time" distraction={(k) => isDistraction("app", k)} empty={t("No programs recorded yet.")} />
          </div>
          <div>
            <h3 className="mb-3 text-sm font-medium">{t("Websites")}</h3>
            <Ranked rows={sites} kind="site" unit="time" distraction={(k) => isDistraction("site", k)} empty={t("No websites recorded yet (needs the extension).")} />
          </div>
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-muted">{t("Nothing recorded in this period yet. Screen time counts from now on while OpenBlocker runs.")}</p>
      )}
    </section>
  );
}

const appName = (exe: string) => {
  const known = APPS.find((a) => a.exe.toLowerCase() === exe);
  if (known) return known.name;
  const stem = exe.replace(/\.exe$/, "");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
};

/** Ranked bars: one row per program or website, longest first. */
function Ranked({
  rows,
  kind,
  unit,
  empty,
  distraction,
}: {
  rows: [string, number][];
  kind: "app" | "site";
  unit: "time" | "count";
  empty: string;
  distraction?: (key: string) => boolean;
}) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="py-4 text-sm text-muted">{empty}</p>;
  const shown = all ? rows.slice(0, 40) : rows.slice(0, 8);
  const max = rows[0][1];
  return (
    <div>
      <ul className="space-y-2.5">
        {shown.map(([key, v]) => (
          <li key={key} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {kind === "app" ? <AppIcon name={appName(key)} exe={key} size={18} /> : <SiteIcon domain={key} size={18} />}
              <span className="truncate" title={key}>
                {kind === "app" ? appName(key) : (siteName(key) ?? key)}
              </span>
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-elevated">
              <span className={clsx("block h-full rounded-full", distraction?.(key) ? "bg-warn" : "bg-accent")} style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
            </span>
            <span className="w-16 text-right text-xs text-muted tabular-nums">{unit === "time" ? hours(v) : `${v}×`}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between text-xs">
        {distraction ? (
          <span className="flex items-center gap-3 text-faint">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-warn" /> {t("in a block list")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-accent" /> {t("other")}
            </span>
          </span>
        ) : (
          <span />
        )}
        {rows.length > 8 && (
          <button className="text-muted hover:text-fg" onClick={() => setAll(!all)}>
            {all ? t("Show less") : t("Show all {n}", { n: Math.min(rows.length, 40) })}
          </button>
        )}
      </div>
    </div>
  );
}

