import clsx from "clsx";
import { CalendarClock, Flame, Lock, LockKeyhole, Play, Plus, ShieldCheck, Square, Timer, TypeIcon, Unlock, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { Page } from "../App";
import { UnlockModal } from "../components/UnlockModal";
import { ListBadge, Segmented } from "../components/ui";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { ActiveBlock, LockMode, State } from "../lib/types";
import { DAYS, dateKey, fmtClock, fmtDuration, fmtMinutes, fmtTime, listTargets, minuteOfDay, weekday } from "../lib/util";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { snap } = useStore();
  const { state, status } = snap!;
  const [unlockId, setUnlockId] = useState<string | null>(null);

  return (
    <>
      <div className="mb-8">
        <p className="text-sm text-muted">{new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="font-display mt-1 text-3xl font-semibold tracking-tight">{greeting()} 👋</h1>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="flex flex-col gap-5 lg:col-span-3">
          <ActiveCard active={status.active} state={state} onUnlock={setUnlockId} go={go} />
          <QuickBlock state={state} go={go} />
        </div>
        <div className="flex flex-col gap-5 lg:col-span-2">
          <StatsCard state={state} />
          <TodayTimeline state={state} go={go} />
        </div>
      </div>
      <UnlockModal sessionId={unlockId} onClose={() => setUnlockId(null)} />
    </>
  );
}

function ActiveCard({ active, state, onUnlock, go }: { active: ActiveBlock[]; state: State; onUnlock: (id: string) => void; go: (p: Page) => void }) {
  const { now, run } = useStore();
  if (active.length === 0) {
    return (
      <div className="card relative overflow-hidden p-6">
        <div className="absolute -top-16 -right-16 size-48 rounded-full bg-accent/10 blur-3xl" />
        <div className="flex items-center gap-4">
          <div className="grid size-12 place-items-center rounded-2xl bg-elevated">
            <ShieldCheck className="text-muted" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold">No active blocks</h2>
            <p className="text-sm text-muted">Everything is reachable right now. Start a quick block below or plan your week.</p>
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button className="btn-ghost" onClick={() => go("schedule")}>
            <CalendarClock size={16} /> Plan schedule
          </button>
          <button className="btn-ghost" onClick={() => go("focus")}>
            <Timer size={16} /> Start pomodoro
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="card relative overflow-hidden p-6">
      <div className="absolute -top-20 -right-10 size-56 rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="mb-4 flex items-center gap-2">
        <span className="pulse-dot size-2.5 rounded-full bg-good" />
        <h2 className="font-display text-lg font-semibold">Blocking now</h2>
      </div>
      <div className="flex flex-col gap-3">
        {active.map((b) => {
          const list = state.lists.find((l) => l.id === b.listId)!;
          const session = b.source === "session" ? state.sessions.find((s) => s.id === b.refId) : undefined;
          const schedule = b.source === "schedule" ? state.schedules.find((s) => s.id === b.refId) : undefined;
          const start = session?.startedAt ?? (b.source === "pomodoro" ? state.pomodoro?.phaseStartedAt : undefined);
          const pct = start ? Math.min(100, ((now - start) / (b.endsAt - start)) * 100) : null;
          const what =
            b.source === "session" ? "Quick block" : b.source === "pomodoro" ? "Focus timer" : schedule?.label || "Scheduled";
          return (
            <div key={`${b.source}-${b.refId}`} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center gap-3">
                <ListBadge list={list} className="min-w-0 flex-1" />
                <span className="text-xs text-muted">{what}</span>
                {b.locked && <Lock size={14} className="text-amber-400" aria-label="Locked" />}
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <div className="font-display text-2xl font-semibold tabular-nums">{fmtDuration(b.endsAt - now)}</div>
                  <div className="text-xs text-muted">
                    until {fmtTime(b.endsAt)} · {listTargets(state, list).sites.size} sites · {listTargets(state, list).apps.size} apps
                  </div>
                </div>
                {session && (
                  <div className="flex gap-2">
                    <button className="btn-ghost px-3 py-1.5" onClick={() => run(() => api.extendSession(session.id, 15), "Extended by 15 minutes.")}>
                      <Plus size={14} /> 15m
                    </button>
                    {session.lock === "timer" ? (
                      <button className="btn-ghost px-3 py-1.5" disabled title="Locked until the timer ends">
                        <LockKeyhole size={14} />
                      </button>
                    ) : (
                      <button
                        className="btn-ghost px-3 py-1.5"
                        onClick={() => (session.lock === "text" ? onUnlock(session.id) : run(() => api.stopSession(session.id), "Block stopped."))}
                      >
                        <Square size={14} /> Stop
                      </button>
                    )}
                  </div>
                )}
              </div>
              {pct !== null && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-elevated">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: list.color }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PRESETS = [
  { label: "25m", min: 25 },
  { label: "1h", min: 60 },
  { label: "2h", min: 120 },
  { label: "4h", min: 240 },
  { label: "Rest of day", min: -1 },
];

function QuickBlock({ state, go }: { state: State; go: (p: Page) => void }) {
  const { run } = useStore();
  const [listId, setListId] = useState(state.lists[0]?.id ?? "");
  const [minutes, setMinutes] = useState(60);
  const [custom, setCustom] = useState("");
  const [lock, setLock] = useState<LockMode>("none");

  const effective = minutes === -1 ? Math.max(1, 1440 - minuteOfDay(new Date())) : custom ? Number(custom) : minutes;

  if (state.lists.length === 0) {
    return (
      <div className="card p-6">
        <h2 className="font-display text-lg font-semibold">Quick block</h2>
        <p className="mt-1 text-sm text-muted">Create a block list first.</p>
        <button className="btn-primary mt-4" onClick={() => go("lists")}>
          <Plus size={16} /> New block list
        </button>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="mb-5 flex items-center gap-2">
        <Zap size={18} className="text-accent" />
        <h2 className="font-display text-lg font-semibold">Quick block</h2>
      </div>

      <span className="label">What</span>
      <div className="mb-5 flex flex-wrap gap-2">
        {state.lists.map((l) => (
          <button
            key={l.id}
            onClick={() => setListId(l.id)}
            className={clsx(
              "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
              listId === l.id ? "border-transparent text-fg ring-2" : "border-line bg-panel text-muted hover:text-fg",
            )}
            style={listId === l.id ? { background: `color-mix(in srgb, ${l.color} 18%, transparent)`, ["--tw-ring-color" as string]: l.color } : undefined}
          >
            <span>{l.icon}</span>
            {l.name}
          </button>
        ))}
      </div>

      <span className="label">For how long</span>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented
          value={custom ? 0 : minutes}
          onChange={(v) => {
            setMinutes(v);
            setCustom("");
          }}
          options={PRESETS.map((p) => ({ value: p.min, label: p.label }))}
        />
        <div className="relative w-32">
          <input
            className="input pr-12"
            type="number"
            min={1}
            placeholder="Custom"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
          />
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-faint">min</span>
        </div>
      </div>

      <span className="label">How strict</span>
      <Segmented
        className="mb-6 w-full"
        value={lock}
        onChange={setLock}
        options={[
          { value: "none", label: <><Unlock size={14} /> Flexible</>, title: "Can be stopped any time" },
          { value: "text", label: <><TypeIcon size={14} /> Type to unlock</>, title: "Stopping requires typing a long random text" },
          { value: "timer", label: <><Lock size={14} /> Locked</>, title: "Cannot be stopped until the time is over" },
        ]}
      />

      <button
        className="btn-primary w-full py-3 text-base"
        disabled={!listId || !effective}
        onClick={() => run(() => api.startSession(listId, effective, lock), `Blocking for ${fmtMinutes(effective)}. You've got this!`)}
      >
        <Play size={18} /> Start blocking · {fmtMinutes(effective)}
      </button>
    </div>
  );
}

function StatsCard({ state }: { state: State }) {
  const today = state.stats[dateKey(new Date())] ?? { focusSeconds: 0, blockedLaunches: 0, pomodoros: 0 };
  const week = useMemo(() => {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push({ day: DAYS[weekday(d)], hours: (state.stats[dateKey(d)]?.focusSeconds ?? 0) / 3600, today: i === 0 });
    }
    return out;
  }, [state.stats]);
  const max = Math.max(1, ...week.map((w) => w.hours));
  const streak = useMemo(() => {
    let n = 0;
    const d = new Date();
    if (!(state.stats[dateKey(d)]?.focusSeconds > 0)) d.setDate(d.getDate() - 1);
    while ((state.stats[dateKey(d)]?.focusSeconds ?? 0) > 0) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }, [state.stats]);

  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Your focus</h2>
        {streak > 0 && (
          <span className="chip border-orange-500/30 bg-orange-500/10 text-orange-300">
            <Flame size={13} /> {streak}-day streak
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Focused today" value={fmtDuration(today.focusSeconds * 1000, false)} />
        <Stat label="Pomodoros" value={String(today.pomodoros)} />
        <Stat label="Apps closed" value={String(today.blockedLaunches)} />
      </div>
      <div className="mt-6 flex h-32 gap-2">
        {week.map((w, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center gap-1.5" title={`${w.hours.toFixed(1)} h focused`}>
            <div className="relative w-full flex-1">
              <div
                className={clsx("absolute inset-x-0 bottom-0 rounded-md transition-all", w.today ? "bg-gradient-to-t from-violet-600 to-cyan-400" : "bg-line-strong")}
                style={{ height: `${Math.max(4, (w.hours / max) * 100)}%` }}
              />
            </div>
            <span className={clsx("text-[11px]", w.today ? "text-fg" : "text-faint")}>{w.day}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-panel p-3">
      <div className="font-display text-xl font-semibold whitespace-nowrap tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function TodayTimeline({ state, go }: { state: State; go: (p: Page) => void }) {
  const now = new Date();
  const d = weekday(now);
  const m = minuteOfDay(now);
  const items = state.schedules
    .flatMap((s) => {
      const out: { start: number; end: number; s: typeof s }[] = [];
      const yesterday = (d + 6) % 7;
      if (s.start > s.end && s.days.includes(yesterday)) out.push({ start: 0, end: s.end, s });
      if (s.days.includes(d)) out.push({ start: s.start, end: s.start >= s.end ? 1440 : s.end, s });
      return out;
    })
    .sort((a, b) => a.start - b.start);

  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Today's schedule</h2>
        <button className="text-xs text-muted hover:text-fg" onClick={() => go("schedule")}>
          Open calendar →
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing scheduled today.</p>
      ) : (
        <ol className="relative flex flex-col gap-2">
          {items.map(({ start, end, s }, i) => {
            const list = state.lists.find((l) => l.id === s.listId);
            if (!list) return null;
            const live = m >= start && m < end;
            const past = m >= end;
            return (
              <li key={i} className={clsx("flex items-center gap-3 rounded-xl p-2.5", live && "bg-panel ring-1 ring-line", past && "opacity-45")}>
                <span className="h-9 w-1 rounded-full" style={{ background: list.color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {list.icon} {s.label || list.name}
                  </div>
                  <div className="text-xs text-muted tabular-nums">
                    {fmtClock(start)} – {end === 1440 ? "24:00" : fmtClock(end)}
                  </div>
                </div>
                {s.locked && <Lock size={13} className="text-amber-400" />}
                {live && <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300">now</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
