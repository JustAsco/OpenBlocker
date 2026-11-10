import { AlertTriangle, Monitor, RotateCcw, ShieldOff, Snowflake } from "lucide-react";
import { useState } from "react";
import { HoldButton, PageHeader, Segmented } from "../components/ui";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { fmtDuration, fmtMinutes, fmtTime } from "../lib/util";

const PRESETS = [15, 30, 60, 120, 240];

export function FreezePage() {
  const { snap, run, now } = useStore();
  const freeze = snap!.state.freeze;
  const [minutes, setMinutes] = useState(30);
  const [message, setMessage] = useState("Go outside. Breathe. You'll thank yourself later.");

  if (freeze) {
    return (
      <>
        <PageHeader title="Freeze PC" />
        <div className="card grid place-items-center p-12 text-center">
          <Snowflake size={40} className="text-cyan-300" />
          <h2 className="font-display mt-4 text-2xl font-semibold">Frozen for {fmtDuration(freeze.endsAt - now)}</h2>
          <p className="mt-1 text-sm text-muted">Unlocks at {fmtTime(freeze.endsAt)}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Freeze PC" subtitle="Lock your whole computer for a while. Ideal for breaks, bedtime, or when you just need to get away." />
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="card p-6 lg:col-span-3">
          <span className="label">Duration</span>
          <Segmented
            className="mb-4 w-full"
            value={PRESETS.includes(minutes) ? minutes : -1}
            onChange={(v) => v > 0 && setMinutes(v)}
            options={PRESETS.map((m) => ({ value: m, label: fmtMinutes(m) }))}
          />
          <input type="range" min={5} max={720} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="mb-1 w-full accent-cyan-400" />
          <p className="mb-6 text-sm text-muted">
            <span className="font-display text-xl font-semibold text-fg">{fmtMinutes(minutes)}</span> · until{" "}
            {new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>

          <span className="label">Message on the lock screen</span>
          <textarea className="input mb-6 h-20 resize-none" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} />

          <HoldButton
            className="btn w-full bg-gradient-to-r from-cyan-500 to-sky-600 py-3 text-base text-white shadow-lg shadow-cyan-900/30"
            onConfirm={() => run(() => api.startFreeze(minutes, message), "Frozen. See you soon ❄️")}
          >
            <Snowflake size={18} /> Hold to freeze for {fmtMinutes(minutes)}
          </HoldButton>
        </div>

        <div className="card p-6 lg:col-span-2">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle size={16} className="text-amber-400" /> Before you freeze
          </h3>
          <ul className="space-y-4 text-sm text-muted">
            <li className="flex gap-3">
              <Monitor size={18} className="mt-0.5 shrink-0 text-faint" />
              Every monitor is covered by a full-screen lock that stays on top. There is no unlock button.
            </li>
            <li className="flex gap-3">
              <ShieldOff size={18} className="mt-0.5 shrink-0 text-faint" />
              Task Manager is closed while frozen (can be changed in Settings).
            </li>
            <li className="flex gap-3">
              <RotateCcw size={18} className="mt-0.5 shrink-0 text-faint" />
              The freeze is saved. If OpenBlocker is restarted, it resumes until the time is up.
            </li>
          </ul>
          <p className="mt-6 rounded-xl bg-panel p-3 text-xs text-faint">Save your work first. Music and downloads keep running in the background.</p>
        </div>
      </div>
    </>
  );
}
