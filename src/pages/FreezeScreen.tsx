import { Snowflake } from "lucide-react";
import { useMemo, useState } from "react";
import { ResetModal } from "../components/ResetModal";
import { Toasts, useSecretClicks } from "../components/ui";
import { useStore } from "../lib/store";
import { fmtTimer } from "../lib/util";
import { t, tx } from "../lib/i18n";

const IDEAS = ["Stretch for two minutes", "Drink a glass of water", "Step outside and look at something far away", "Tidy your desk", "Call someone you like", "Write down tomorrow's top 3 tasks", "Do 10 slow breaths"];

/** Rendered inside the full-screen, always-on-top freeze windows. */
export function FreezeScreen() {
  const { snap, now } = useStore();
  const freeze = snap?.state.freeze;
  const idea = useMemo(() => IDEAS[Math.floor(Math.random() * IDEAS.length)], []);
  const total = freeze ? freeze.endsAt - freeze.startedAt : 1;
  const left = freeze ? freeze.endsAt - now : 0;
  const pct = Math.max(0, Math.min(100, (1 - left / total) * 100));
  // The emergency reset stays reachable even while frozen (7 clicks on the
  // unlock time), so no configuration can lock someone out for good.
  const [resetOpen, setResetOpen] = useState(false);
  const secret = useSecretClicks(() => setResetOpen(true));

  return (
    <div
      className="relative grid h-full place-items-center overflow-hidden text-center"
      style={{ background: "radial-gradient(ellipse at top, #0e2a3d 0%, #0a0a10 60%)" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-1/3 left-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-cyan-500/10 blur-3xl" style={{ animationDuration: "6s" }} />
      <div className="relative">
        <Snowflake size={56} className="mx-auto mb-6 text-cyan-300" />
        <p className="mb-2 text-sm font-medium tracking-[0.3em] text-cyan-200/70 uppercase">{t("Computer frozen")}</p>
        <div className="font-display text-[8rem] leading-none font-semibold tracking-tight tabular-nums">{freeze ? fmtTimer(left) : "00:00"}</div>
        <div className="mx-auto mt-8 h-1.5 w-80 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-sky-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        {freeze?.message && <p className="mx-auto mt-10 max-w-xl text-xl text-fg/90">{freeze.message}</p>}
        <p className="mt-6 text-sm text-muted">
          {tx("Idea: {idea}", { idea: <span className="text-fg/80">{t(idea)}</span> })}
        </p>
        <p className="mt-16 cursor-default text-xs text-faint select-none" onClick={secret}>
          {t("Unlocks at {time}", { time: freeze ? new Date(freeze.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("now") })}
        </p>
      </div>
      <div className="text-left">
        <ResetModal open={resetOpen} onClose={() => setResetOpen(false)} />
      </div>
      <Toasts />
    </div>
  );
}
