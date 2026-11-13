import clsx from "clsx";
import { Hourglass, Lock, Plus, Puzzle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Page } from "../App";
import { LockWarning, lockedWord } from "../components/LockWarning";
import { PasswordEscape } from "../components/PasswordEscape";
import { ListBadge, Modal, PageHeader, Segmented, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { State, UsageLimit } from "../lib/types";
import { DAYS, DAYS_LONG, fmtMinutes, weekday } from "../lib/util";
import { t, tx } from "../lib/i18n";

const PRESETS = [15, 30, 45, 60, 90, 120];

function daysText(days: number[]) {
  const d = [...days].sort().join();
  return d === "0,1,2,3,4,5,6" ? t("Every day") : d === "0,1,2,3,4" ? t("Weekdays") : d === "5,6" ? t("Weekends") : days.map((x) => DAYS[x]).join(", ");
}

export function LimitsPage({ go }: { go: (p: Page) => void }) {
  const { snap, now } = useStore();
  const { state, status } = snap!;
  const [editing, setEditing] = useState<UsageLimit | null>(null);
  const blockLists = state.lists.filter((l) => l.mode === "block");
  const today = weekday(new Date(now));
  const blank = (): UsageLimit => ({ id: "", listId: blockLists[0]?.id ?? "", minutes: 30, days: [0, 1, 2, 3, 4, 5, 6], locked: false, password: false });

  return (
    <>
      <PageHeader
        title={t("Daily limits")}
        subtitle={t("Give a block list a daily allowance. Time counts while one of its apps or websites is in front and you're active; once it's used up, it's blocked until midnight.")}
        actions={
          <button className="btn-primary" disabled={!blockLists.length} onClick={() => setEditing(blank())}>
            <Plus size={16} /> {t("New limit")}
          </button>
        }
      />

      {status.extension.length === 0 && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
          <Puzzle size={16} className="shrink-0" />
          <span className="flex-1">{t("Time on websites can only be counted with the browser extension. Apps are counted either way.")}</span>
          <button className="btn-ghost py-1" onClick={() => go("settings")}>
            {t("Set up extension")}
          </button>
        </div>
      )}

      {state.limits.length === 0 ? (
        <div className="card grid place-items-center gap-3 p-12 text-center">
          <Hourglass size={28} className="text-accent" />
          <p className="max-w-md text-sm text-muted">
            {t("For example: 30 minutes of YouTube a day, or an hour of games on weekdays. You can use any block list you already have.")}
          </p>
          <button className="btn-primary mt-2" disabled={!blockLists.length} onClick={() => setEditing(blank())}>
            <Plus size={16} /> {t("New limit")}
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {state.limits.map((l) => {
            const list = state.lists.find((x) => x.id === l.listId);
            if (!list) return null;
            const applies = l.days.includes(today);
            const used = status.usageToday[l.id] ?? 0;
            const allowed = l.minutes * 60;
            const done = applies && used >= allowed;
            const pct = Math.min(100, (used / allowed) * 100);
            return (
              <button key={l.id} className="card p-5 text-left transition hover:border-line-strong" onClick={() => setEditing(l)}>
                <div className="mb-3 flex items-center gap-2">
                  <ListBadge list={list} />
                  <span className="ml-auto flex items-center gap-1.5 text-sm text-muted">
                    {l.locked && <Lock size={13} className="text-amber-400" aria-label={t("Locked once used up")} />}
                    {t("{duration} / day", { duration: fmtMinutes(l.minutes) })}
                  </span>
                </div>
                <div className="mb-2 h-2 overflow-hidden rounded-full bg-elevated">
                  <div className={clsx("h-full rounded-full transition-all", done ? "bg-red-400" : pct > 80 ? "bg-amber-400" : "bg-accent")} style={{ width: `${applies ? pct : 0}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted">
                  <span>
                    {!applies
                      ? t("No limit today")
                      : done
                        ? t("Used up · blocked until midnight")
                        : t("{used} used · {left} left", { used: fmtMinutes(Math.floor(used / 60)), left: fmtMinutes(Math.ceil((allowed - used) / 60)) })}
                  </span>
                  <span>{daysText(l.days)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <LimitEditor limit={editing} state={state} usedUp={!!editing && status.active.some((b) => b.source === "limit" && b.refId === editing.id)} onClose={() => setEditing(null)} />
    </>
  );
}

function LimitEditor({ limit, state, usedUp, onClose }: { limit: UsageLimit | null; state: State; usedUp: boolean; onClose: () => void }) {
  const { run, snap } = useStore();
  const [l, setL] = useState<UsageLimit | null>(limit);
  const [custom, setCustom] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setL(limit);
    setCustom(limit && !PRESETS.includes(limit.minutes) ? String(limit.minutes) : "");
  }, [limit]);
  if (!l) return null;

  const before = state.limits.find((x) => x.id === l.id);
  const lockIsNew = l.locked && !before?.locked;
  const list = state.lists.find((x) => x.id === l.listId);
  const setDays = (days: number[]) => setL({ ...l, days: [...days].sort() });
  const save = () => run(() => api.saveLimit(l), "Limit saved.").then((ok) => ok && onClose());

  return (
    <Modal open onClose={onClose} title={l.id ? t("Edit limit") : t("New limit")} width={560}>
      {usedUp && before?.locked && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <Lock size={16} className="shrink-0" /> {t("Used up and locked until midnight. You can make it stricter, but not looser.")}
        </div>
      )}
      <span className="label">{t("Block list")}</span>
      <div className="mb-5 flex flex-wrap gap-2">
        {state.lists
          .filter((x) => x.mode === "block")
          .map((x) => (
            <button
              key={x.id}
              onClick={() => setL({ ...l, listId: x.id })}
              className={clsx("flex items-center gap-2 rounded-xl border px-3 py-2 text-sm", l.listId === x.id ? "border-transparent ring-2" : "border-line bg-card text-muted hover:text-fg")}
              style={l.listId === x.id ? { background: `color-mix(in srgb, ${x.color} 18%, transparent)`, ["--tw-ring-color" as string]: x.color } : undefined}
            >
              {x.icon} {x.name}
            </button>
          ))}
      </div>

      <span className="label">{t("Time per day")}</span>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented
          value={custom ? 0 : l.minutes}
          onChange={(minutes) => {
            setL({ ...l, minutes });
            setCustom("");
          }}
          options={PRESETS.map((m) => ({ value: m, label: fmtMinutes(m) }))}
        />
        <div className="relative w-32">
          <input
            className="input pr-12"
            type="number"
            min={1}
            placeholder={t("Custom")}
            value={custom}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "");
              setCustom(v);
              if (Number(v) > 0) setL({ ...l, minutes: Number(v) });
            }}
          />
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-faint">{t("min")}</span>
        </div>
      </div>

      <div className="mb-1.5 flex items-center justify-between">
        <span className="label mb-0">{t("Days")}</span>
        <div className="flex gap-3 text-xs text-muted">
          <button className="hover:text-fg" onClick={() => setDays([0, 1, 2, 3, 4])}>{t("Weekdays")}</button>
          <button className="hover:text-fg" onClick={() => setDays([5, 6])}>{t("Weekend")}</button>
          <button className="hover:text-fg" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>{t("Every day")}</button>
        </div>
      </div>
      <div className="mb-5 grid grid-cols-7 gap-1.5">
        {DAYS.map((d, i) => (
          <button
            key={d}
            title={DAYS_LONG[i]}
            onClick={() => setDays(l.days.includes(i) ? l.days.filter((x) => x !== i) : [...l.days, i])}
            className={clsx("rounded-xl border py-2 text-sm font-medium transition", l.days.includes(i) ? "border-accent bg-accent/20 text-violet-100" : "border-line bg-card text-muted hover:text-fg")}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="divide-y divide-line border-t border-line">
        <Toggle
          label={t("Lock once used up")}
          hint={t("When today's time runs out, the block can't be stopped and the limit can't be raised or removed until midnight.")}
          checked={l.locked}
          onChange={(locked) => setL({ ...l, locked })}
        />
        {l.locked && <PasswordEscape what={t("the block")} checked={l.password} onChange={(password) => setL({ ...l, password })} />}
      </div>

      <div className="mt-6 flex items-center gap-2">
        {l.id && (
          <button className="btn-danger" onClick={() => run(() => api.deleteLimit(l.id), "Limit deleted.").then((ok) => ok && onClose())}>
            <Trash2 size={15} /> {t("Delete")}
          </button>
        )}
        <div className="flex-1" />
        <button className="btn-ghost" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className="btn-primary" disabled={!l.listId || !l.days.length || !l.minutes} onClick={() => (lockIsNew ? setConfirming(true) : save())}>
          {l.locked && <Lock size={15} />} {t("Save")}
        </button>
      </div>
      <LockWarning
        open={confirming}
        summary={tx("Once today's {minutes} are used up, {list} is {locked} until midnight.", {
          minutes: fmtMinutes(l.minutes),
          list: list?.name ?? t("the list"),
          locked: lockedWord(),
        })}
        escape={l.password && snap!.status.passwordSet}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          save();
        }}
      />
    </Modal>
  );
}
