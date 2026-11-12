import clsx from "clsx";
import { Coffee, KeyRound, Lock, Pause, Play, SkipForward, Square, Target } from "lucide-react";
import { useState } from "react";
import { LockWarning, lockedWord } from "../components/LockWarning";
import { PasswordEscape } from "../components/PasswordEscape";
import { PasswordModal } from "../components/UnlockModal";
import { PageHeader, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { PomodoroConfig } from "../lib/types";
import { fmtMinutes, fmtTimer } from "../lib/util";
import { t, tx } from "../lib/i18n";

const PRESETS: { name: string; desc: string; cfg: Partial<PomodoroConfig> }[] = [
  { name: t("Classic"), desc: t("25 / 5 · long 15"), cfg: { focusMin: 25, breakMin: 5, longBreakMin: 15, rounds: 4 } },
  { name: t("Deep work"), desc: t("50 / 10 · long 20"), cfg: { focusMin: 50, breakMin: 10, longBreakMin: 20, rounds: 3 } },
  { name: t("Flow"), desc: t("90 / 20 · long 30"), cfg: { focusMin: 90, breakMin: 20, longBreakMin: 30, rounds: 2 } },
  { name: t("Sprint"), desc: t("15 / 3 · long 10"), cfg: { focusMin: 15, breakMin: 3, longBreakMin: 10, rounds: 4 } },
];

const PHASE = {
  focus: { label: t("Focus"), color: "#8b5cf6", icon: Target },
  break: { label: t("Short break"), color: "#10b981", icon: Coffee },
  longBreak: { label: t("Long break"), color: "#06b6d4", icon: Coffee },
};

export function FocusPage() {
  const { snap } = useStore();
  const p = snap!.state.pomodoro;
  return (
    <>
      <PageHeader title={t("Focus timer")} subtitle={t("Pomodoro sessions that automatically block your distractions while you focus.")} />
      {p ? <Running /> : <Setup />}
    </>
  );
}

function Running() {
  const { snap, run, now } = useStore();
  const p = snap!.state.pomodoro!;
  const list = snap!.state.lists.find((l) => l.id === p.config.listId);
  const total = p.phaseEndsAt - p.phaseStartedAt;
  const left = p.pausedRemaining ?? p.phaseEndsAt - now;
  const frac = Math.max(0, Math.min(1, 1 - left / total));
  const meta = PHASE[p.phase];
  const lockedNow = p.config.locked && p.phase === "focus";
  const [asking, setAsking] = useState(false);
  const R = 130;
  const C = 2 * Math.PI * R;
  const roundInCycle = ((p.round - 1) % p.config.rounds) + 1;

  return (
    <div className="card relative overflow-hidden px-6 py-12">
      <div className="absolute top-1/2 left-1/2 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-25 blur-3xl" style={{ background: meta.color }} />
      <div className="relative flex flex-col items-center">
        <span className="chip mb-6 py-1.5 text-sm" style={{ color: meta.color, borderColor: `color-mix(in srgb, ${meta.color} 40%, transparent)` }}>
          <meta.icon size={14} /> {meta.label} ·{" "}
          {p.config.totalRounds ? t("round {n} of {total}", { n: p.round, total: p.config.totalRounds }) : t("round {n}", { n: p.round })}
        </span>
        <div className="relative">
          <svg width={300} height={300} className="-rotate-90">
            <circle cx={150} cy={150} r={R} fill="none" stroke="var(--color-elevated)" strokeWidth={12} />
            <circle
              cx={150}
              cy={150}
              r={R}
              fill="none"
              stroke={meta.color}
              strokeWidth={12}
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - frac)}
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="font-display text-6xl font-semibold tracking-tight tabular-nums">{fmtTimer(left)}</div>
              <div className="mt-1 text-sm text-muted">{p.pausedRemaining !== null ? t("Paused") : p.phase === "focus" ? (list ? `Blocking ${list.icon} ${list.name}` : t("No blocking")) : t("Relax — nothing is blocked")}</div>
            </div>
          </div>
        </div>
        <div className="mt-6 flex gap-2">
          {Array.from({ length: p.config.rounds }, (_, i) => (
            <span key={i} className={clsx("h-2 w-8 rounded-full", i < roundInCycle - (p.phase === "focus" ? 1 : 0) ? "bg-accent" : i === roundInCycle - 1 && p.phase === "focus" ? "bg-accent/50" : "bg-elevated")} />
          ))}
        </div>
        <div className="mt-8 flex gap-3">
          {p.pausedRemaining !== null ? (
            <button className="btn-primary px-6" onClick={() => run(api.pomodoroResume)}>
              <Play size={16} /> {t("Resume")}
            </button>
          ) : (
            <button className="btn-ghost px-6" disabled={lockedNow} onClick={() => run(api.pomodoroPause)}>
              <Pause size={16} /> {t("Pause")}
            </button>
          )}
          <button className="btn-ghost" disabled={lockedNow} onClick={() => run(api.pomodoroSkip)}>
            <SkipForward size={16} /> {t("Skip")}
          </button>
          {lockedNow && p.config.password ? (
            <button className="btn-ghost" onClick={() => setAsking(true)}>
              <KeyRound size={16} /> {t("Stop")}
            </button>
          ) : (
            <button className="btn-ghost" disabled={lockedNow} onClick={() => run(api.pomodoroStop, "Focus session ended.")}>
              <Square size={16} /> {t("Stop")}
            </button>
          )}
        </div>
        {lockedNow && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-amber-300">
            <Lock size={14} />  {p.config.password ? t("Locked until this focus round ends, unless the unlock password is entered.") : t("Locked until this focus round ends.")}
          </p>
        )}
        {asking && (
          <PasswordModal
            text={t("This focus session is locked. Only the unlock password can stop it early.")}
            onClose={() => setAsking(false)}
            onSubmit={(password) => run(() => api.endBlock("pomodoro", password), "Focus session ended.")}
          />
        )}
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, suffix = "min" }: { label: string; value: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="relative">
        <input className="input pr-12" type="number" min={1} value={value} onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))} />
        <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-faint">{suffix}</span>
      </div>
    </div>
  );
}

function Setup() {
  const { snap, run } = useStore();
  const lists = snap!.state.lists;
  const [cfg, setCfg] = useState<PomodoroConfig>({
    focusMin: 25,
    breakMin: 5,
    longBreakMin: 15,
    rounds: 4,
    listId: lists[0]?.id ?? null,
    locked: false,
    password: false,
    totalRounds: 4,
  });
  const set = (p: Partial<PomodoroConfig>) => setCfg({ ...cfg, ...p });
  const [confirming, setConfirming] = useState(false);
  const start = () => run(() => api.pomodoroStart(cfg), "Focus mode on. Let's go! 🎯");
  const totalMin = cfg.totalRounds
    ? cfg.totalRounds * cfg.focusMin + (cfg.totalRounds - 1 - Math.floor((cfg.totalRounds - 1) / cfg.rounds)) * cfg.breakMin + Math.floor((cfg.totalRounds - 1) / cfg.rounds) * cfg.longBreakMin
    : null;

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="card p-6 lg:col-span-3">
        <span className="label">{t("Preset")}</span>
        <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PRESETS.map((pr) => {
            const on = pr.cfg.focusMin === cfg.focusMin && pr.cfg.breakMin === cfg.breakMin;
            return (
              <button key={pr.name} onClick={() => set(pr.cfg)} className={clsx("rounded-xl border p-3 text-left", on ? "border-accent bg-accent/10" : "border-line bg-panel hover:border-line-strong")}>
                <div className="text-sm font-medium">{pr.name}</div>
                <div className="text-xs text-muted">{pr.desc}</div>
              </button>
            );
          })}
        </div>
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField label={t("Focus")} value={cfg.focusMin} onChange={(focusMin) => set({ focusMin })} />
          <NumberField label={t("Break")} value={cfg.breakMin} onChange={(breakMin) => set({ breakMin })} />
          <NumberField label={t("Long break")} value={cfg.longBreakMin} onChange={(longBreakMin) => set({ longBreakMin })} />
          <NumberField label={t("Cycle length")} value={cfg.rounds} onChange={(rounds) => set({ rounds })} suffix={t("rounds")} />
        </div>

        <span className="label">{t("Block during focus")}</span>
        <div className="mb-6 flex flex-wrap gap-2">
          <button onClick={() => set({ listId: null })} className={clsx("rounded-xl border px-3 py-2 text-sm", cfg.listId === null ? "border-accent bg-accent/10" : "border-line bg-panel text-muted")}>
            {t("Nothing")}
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              onClick={() => set({ listId: l.id })}
              className={clsx("rounded-xl border px-3 py-2 text-sm", cfg.listId === l.id ? "border-transparent ring-2" : "border-line bg-panel text-muted hover:text-fg")}
              style={cfg.listId === l.id ? { background: `color-mix(in srgb, ${l.color} 18%, transparent)`, ["--tw-ring-color" as string]: l.color } : undefined}
            >
              {l.icon} {l.name}
            </button>
          ))}
        </div>

        <div className="divide-y divide-line border-t border-line">
          <Toggle
            label={t("Stop after a number of rounds")}
            hint={cfg.totalRounds ? t("Ends after {n} focus rounds (≈ {duration})", { n: cfg.totalRounds, duration: fmtMinutes(totalMin!) }) : t("Runs until you stop it")}
            checked={cfg.totalRounds !== null}
            onChange={(v) => set({ totalRounds: v ? 4 : null })}
          />
          {cfg.totalRounds !== null && (
            <div className="py-3">
              <input type="range" min={1} max={12} value={cfg.totalRounds} onChange={(e) => set({ totalRounds: Number(e.target.value) })} className="w-full accent-violet-500" />
            </div>
          )}
          <Toggle label={t("Lock focus rounds")} hint={t("You can't pause, skip or stop while a focus round is running.")} checked={cfg.locked} onChange={(locked) => set({ locked })} />
          {cfg.locked && <PasswordEscape what={t("a focus round")} checked={!!cfg.password} onChange={(password) => set({ password })} />}
        </div>
      </div>

      <div className="card flex flex-col items-center justify-center p-8 text-center lg:col-span-2">
        <div className="font-display text-7xl font-semibold tracking-tight tabular-nums">{String(cfg.focusMin).padStart(2, "0")}:00</div>
        <p className="mt-2 text-sm text-muted">
          {t("{rounds} × {min} min focus", { rounds: cfg.totalRounds ?? "∞", min: cfg.focusMin })}
        </p>
        <button className="btn-primary mt-8 w-full py-3 text-base" onClick={() => (cfg.locked ? setConfirming(true) : start())}>
          {cfg.locked ? <Lock size={18} /> : <Play size={18} />} {t("Start focusing")}
        </button>
        <LockWarning
          open={confirming}
          summary={
            cfg.totalRounds
              ? tx("Every focus round ({min} min) is {locked} until it ends, for all {rounds} rounds.", { min: cfg.focusMin, rounds: cfg.totalRounds, locked: lockedWord() })
              : tx("Every focus round ({min} min) is {locked} until it ends. The timer runs until you stop it during a break.", { min: cfg.focusMin, locked: lockedWord() })
          }
          escape={!!cfg.password && !!snap?.status.passwordSet}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            start();
          }}
        />
      </div>
    </div>
  );
}
