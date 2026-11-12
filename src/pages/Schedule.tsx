import clsx from "clsx";
import { Lock, Moon, Plus, Sparkles, Sun, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LockWarning } from "../components/LockWarning";
import { PasswordEscape } from "../components/PasswordEscape";
import { Modal, PageHeader, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Schedule, State } from "../lib/types";
import { DAYS, DAYS_LONG, fmtClock, minuteOfDay, parseClock, weekday } from "../lib/util";

const HOUR_PX = 44;
const SNAP = 15;

interface Segment {
  s: Schedule;
  day: number;
  start: number;
  end: number;
  lane: number;
  lanes: number;
}

function segmentsFor(schedules: Schedule[]): Segment[][] {
  const perDay: Omit<Segment, "lane" | "lanes">[][] = Array.from({ length: 7 }, () => []);
  for (const s of schedules) {
    for (const d of s.days) {
      if (s.start === s.end) perDay[d].push({ s, day: d, start: 0, end: 1440 });
      else if (s.start < s.end) perDay[d].push({ s, day: d, start: s.start, end: s.end });
      else {
        perDay[d].push({ s, day: d, start: s.start, end: 1440 });
        perDay[(d + 1) % 7].push({ s, day: (d + 1) % 7, start: 0, end: s.end });
      }
    }
  }
  // Assign side-by-side lanes for overlapping segments.
  return perDay.map((segs) => {
    const sorted = [...segs].sort((a, b) => a.start - b.start || b.end - a.end);
    const out: Segment[] = [];
    let cluster: Segment[] = [];
    let clusterEnd = -1;
    let laneEnds: number[] = [];
    const flush = () => {
      const n = laneEnds.length;
      cluster.forEach((c) => (c.lanes = n));
      out.push(...cluster);
      cluster = [];
      laneEnds = [];
    };
    for (const seg of sorted) {
      if (seg.start >= clusterEnd) flush();
      let lane = laneEnds.findIndex((e) => e <= seg.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(seg.end);
      } else laneEnds[lane] = seg.end;
      cluster.push({ ...seg, lane, lanes: 1 });
      clusterEnd = Math.max(clusterEnd, seg.end);
    }
    flush();
    return out;
  });
}

const blank = (state: State, partial: Partial<Schedule> = {}): Schedule => ({
  id: "",
  listId: state.lists[0]?.id ?? "",
  days: [0, 1, 2, 3, 4],
  start: 9 * 60,
  end: 17 * 60,
  locked: false,
  password: false,
  label: "",
  ...partial,
});

const TEMPLATES: { icon: typeof Sun; name: string; desc: string; s: Partial<Schedule> }[] = [
  { icon: Sun, name: "Work hours", desc: "Mon–Fri · 09:00–17:00", s: { label: "Work hours", days: [0, 1, 2, 3, 4], start: 540, end: 1020 } },
  { icon: Moon, name: "Bedtime", desc: "Every day · 22:30–07:00", s: { label: "Bedtime", days: [0, 1, 2, 3, 4, 5, 6], start: 1350, end: 420, locked: true } },
  { icon: Sparkles, name: "Mindful mornings", desc: "Every day · 06:00–09:00", s: { label: "Morning routine", days: [0, 1, 2, 3, 4, 5, 6], start: 360, end: 540 } },
  { icon: Sun, name: "Weekend detox", desc: "Sat & Sun · all day", s: { label: "Weekend detox", days: [5, 6], start: 0, end: 0 } },
];

export function SchedulePage() {
  const { snap, now } = useStore();
  const state = snap!.state;
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [drag, setDrag] = useState<{ day: number; a: number; b: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const segs = useMemo(() => segmentsFor(state.schedules.filter((s) => state.lists.some((l) => l.id === s.listId))), [state.schedules, state.lists]);
  const today = weekday(new Date(now));
  const nowMin = minuteOfDay(new Date(now));

  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, (Math.min(nowMin, 7 * 60) / 60) * HOUR_PX - 20) });
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const minuteAt = (e: React.PointerEvent, el: HTMLElement) => {
    const y = e.clientY - el.getBoundingClientRect().top;
    return Math.max(0, Math.min(1440, Math.round(((y / HOUR_PX) * 60) / SNAP) * SNAP));
  };

  const weeklyHours = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of state.schedules) {
      const len = s.start === s.end ? 1440 : (s.end - s.start + 1440) % 1440;
      m.set(s.listId, (m.get(s.listId) ?? 0) + (len * s.days.length) / 60);
    }
    return m;
  }, [state.schedules]);

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Drag on the calendar to block a time range. Click a block to edit it."
        actions={
          <button className="btn-primary" disabled={!state.lists.length} onClick={() => setEditing(blank(state))}>
            <Plus size={16} /> New schedule
          </button>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TEMPLATES.map((t) => (
          <button
            key={t.name}
            disabled={!state.lists.length}
            onClick={() => setEditing(blank(state, t.s))}
            className="card flex items-center gap-3 p-3.5 text-left transition hover:border-line-strong hover:bg-elevated"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-elevated">
              <t.icon size={17} className="text-accent" />
            </span>
            <span>
              <span className="block text-sm font-medium">{t.name}</span>
              <span className="text-xs text-muted">{t.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-line bg-panel/60">
          <div />
          {DAYS.map((d, i) => (
            <div key={d} className={clsx("py-3 text-center text-sm font-medium", i === today ? "text-fg" : "text-muted")}>
              <span className={clsx("rounded-lg px-2.5 py-1", i === today && "bg-accent/20 text-violet-200")}>{d}</span>
            </div>
          ))}
        </div>
        <div ref={scroller} className="max-h-[560px] overflow-y-auto">
          <div className="relative grid grid-cols-[56px_repeat(7,1fr)]" style={{ height: 24 * HOUR_PX }}>
            <div className="relative">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-faint tabular-nums" style={{ top: h * HOUR_PX }}>
                  {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
                </div>
              ))}
            </div>
            {DAYS.map((_, day) => (
              <div
                key={day}
                className={clsx("relative cursor-crosshair border-l border-line", day === today && "bg-accent/[0.03]")}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest("[data-seg]")) return;
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  const m = minuteAt(e, e.currentTarget);
                  setDrag({ day, a: m, b: m });
                }}
                onPointerMove={(e) => drag && drag.day === day && setDrag({ ...drag, b: minuteAt(e, e.currentTarget) })}
                onPointerUp={() => {
                  if (!drag) return;
                  let [s, en] = [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)];
                  if (en - s < SNAP) en = Math.min(1440, s + 60);
                  setDrag(null);
                  setEditing(blank(state, { days: [day], start: s, end: en % 1440 }));
                }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: h * HOUR_PX }} />
                ))}
                {segs[day].map((seg, i) => {
                  const list = state.lists.find((l) => l.id === seg.s.listId)!;
                  const h = ((seg.end - seg.start) / 60) * HOUR_PX;
                  return (
                    <button
                      data-seg
                      key={`${seg.s.id}-${i}`}
                      onClick={() => setEditing(seg.s)}
                      className="absolute flex flex-col justify-start overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left text-xs transition hover:brightness-125"
                      style={{
                        top: (seg.start / 60) * HOUR_PX + 1,
                        height: h - 2,
                        // Overlapping blocks cascade like in common calendar apps.
                        left: `calc(${(seg.lane / seg.lanes) * 100}% + 3px)`,
                        width: `calc(${Math.min(100 - (seg.lane / seg.lanes) * 100, seg.lanes > 1 && seg.lane < seg.lanes - 1 ? (170 / seg.lanes) : 100)}% - 6px)`,
                        zIndex: 1 + seg.lane,
                        boxShadow: seg.lane > 0 ? "0 0 0 1.5px var(--color-card)" : undefined,
                        borderColor: list.color,
                        background: `color-mix(in srgb, ${list.color} 22%, var(--color-card))`,
                      }}
                    >
                      <div className="flex items-center gap-1 truncate font-medium">
                        {seg.s.locked && <Lock size={10} className="shrink-0" />}
                        <span className="truncate">
                          {list.icon} {seg.s.label || list.name}
                        </span>
                      </div>
                      {h > 34 && (
                        <div className="truncate text-[11px] opacity-70 tabular-nums">
                          {fmtClock(seg.s.start)}–{seg.s.start === seg.s.end ? "all day" : fmtClock(seg.s.end)}
                        </div>
                      )}
                    </button>
                  );
                })}
                {drag?.day === day && (
                  <div
                    className="pointer-events-none absolute inset-x-1 rounded-lg border border-dashed border-accent bg-accent/20"
                    style={{ top: (Math.min(drag.a, drag.b) / 60) * HOUR_PX, height: Math.max(4, (Math.abs(drag.b - drag.a) / 60) * HOUR_PX) }}
                  >
                    <span className="m-1 inline-block rounded bg-accent px-1.5 text-[11px] font-medium text-white tabular-nums">
                      {fmtClock(Math.min(drag.a, drag.b))}–{fmtClock(Math.max(drag.a, drag.b))}
                    </span>
                  </div>
                )}
                {day === today && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: (nowMin / 60) * HOUR_PX }}>
                    <span className="-ml-1 size-2.5 rounded-full bg-red-500" />
                    <span className="h-0.5 flex-1 bg-red-500" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {state.lists.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {state.lists.map((l) => (
            <span key={l.id} className="chip py-1.5 text-sm">
              <span className="size-2.5 rounded-full" style={{ background: l.color }} />
              {l.icon} {l.name}
              <span className="text-faint">{Math.round(weeklyHours.get(l.id) ?? 0)} h/week</span>
            </span>
          ))}
        </div>
      )}

      <ScheduleEditor schedule={editing} onClose={() => setEditing(null)} state={state} />
    </>
  );
}

function ScheduleEditor({ schedule, onClose, state }: { schedule: Schedule | null; onClose: () => void; state: State }) {
  const { run } = useStore();
  const [s, setS] = useState<Schedule | null>(schedule);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setS(schedule), [schedule]);
  if (!s) return null;

  const allDay = s.start === s.end;
  const overnight = s.end < s.start;
  const len = allDay ? 1440 : (s.end - s.start + 1440) % 1440;
  const setDays = (days: number[]) => setS({ ...s, days: [...days].sort() });
  const toggleDay = (d: number) => setDays(s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d]);
  const list = state.lists.find((l) => l.id === s.listId);
  const save = () => run(() => api.saveSchedule(s), "Schedule saved.").then((ok) => ok && onClose());
  // Warn when a lock is new, or when a locked schedule now covers different times.
  const before = state.schedules.find((x) => x.id === s.id);
  const lockIsNew =
    s.locked && !(before?.locked && before.listId === s.listId && before.start === s.start && before.end === s.end && s.days.every((d) => before.days.includes(d)));
  const neverEnds = len * s.days.length >= 7 * 1440;

  const summary = () => {
    const sorted = [...s.days].sort();
    const daysText =
      sorted.length === 7 ? "every day" : sorted.join() === "0,1,2,3,4" ? "weekdays" : sorted.join() === "5,6" ? "weekends" : sorted.map((d) => DAYS[d]).join(", ");
    const time = allDay ? "all day" : `${fmtClock(s.start)}–${fmtClock(s.end)}${overnight ? " (next day)" : ""}`;
    return `Blocks ${list?.name ?? "…"} ${daysText}, ${time} · ${Math.round((len * s.days.length) / 60)} h/week`;
  };

  return (
    <Modal open onClose={onClose} title={s.id ? "Edit schedule" : "New schedule"} width={560}>
      <span className="label">Block list</span>
      <div className="mb-5 flex flex-wrap gap-2">
        {state.lists.map((l) => (
          <button
            key={l.id}
            onClick={() => setS({ ...s, listId: l.id })}
            className={clsx("flex items-center gap-2 rounded-xl border px-3 py-2 text-sm", s.listId === l.id ? "border-transparent ring-2" : "border-line bg-card text-muted hover:text-fg")}
            style={s.listId === l.id ? { background: `color-mix(in srgb, ${l.color} 18%, transparent)`, ["--tw-ring-color" as string]: l.color } : undefined}
          >
            {l.icon} {l.name}
          </button>
        ))}
      </div>

      <span className="label">Label (optional)</span>
      <input className="input mb-5" value={s.label ?? ""} onChange={(e) => setS({ ...s, label: e.target.value })} placeholder="e.g. Deep work" />

      <div className="mb-1.5 flex items-center justify-between">
        <span className="label mb-0">Days</span>
        <div className="flex gap-3 text-xs text-muted">
          <button className="hover:text-fg" onClick={() => setDays([0, 1, 2, 3, 4])}>Weekdays</button>
          <button className="hover:text-fg" onClick={() => setDays([5, 6])}>Weekend</button>
          <button className="hover:text-fg" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>Every day</button>
        </div>
      </div>
      <div className="mb-5 grid grid-cols-7 gap-1.5">
        {DAYS.map((d, i) => (
          <button
            key={d}
            title={DAYS_LONG[i]}
            onClick={() => toggleDay(i)}
            className={clsx("rounded-xl border py-2 text-sm font-medium transition", s.days.includes(i) ? "border-accent bg-accent/20 text-violet-100" : "border-line bg-card text-muted hover:text-fg")}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="mb-2 grid grid-cols-2 gap-3">
        <div>
          <span className="label">From</span>
          <input type="time" className="input" disabled={allDay} value={fmtClock(s.start)} onChange={(e) => setS({ ...s, start: parseClock(e.target.value) })} />
        </div>
        <div>
          <span className="label">Until</span>
          <input type="time" className="input" disabled={allDay} value={fmtClock(s.end)} onChange={(e) => setS({ ...s, end: parseClock(e.target.value) })} />
        </div>
      </div>
      {overnight && <p className="mb-2 flex items-center gap-1.5 text-xs text-cyan-300"><Moon size={12} /> Runs overnight and ends the next morning.</p>}

      <div className="divide-y divide-line">
        <Toggle label="All day" checked={allDay} onChange={(v) => setS(v ? { ...s, start: 0, end: 0 } : { ...s, start: 540, end: 1020 })} />
        <Toggle
          label="Lock while running"
          hint="Once it starts, this schedule and its list can't be edited, removed or stopped until it ends."
          checked={s.locked}
          onChange={(locked) => setS({ ...s, locked })}
        />
        {s.locked && <PasswordEscape what="this schedule" checked={s.password} onChange={(password) => setS({ ...s, password })} />}
      </div>

      <p className="mt-4 rounded-xl bg-panel px-4 py-3 text-sm text-muted">{summary()}</p>

      <div className="mt-6 flex items-center gap-2">
        {s.id && (
          <button className="btn-danger" onClick={() => run(() => api.deleteSchedule(s.id), "Schedule deleted.").then((ok) => ok && onClose())}>
            <Trash2 size={15} /> Delete
          </button>
        )}
        <div className="flex-1" />
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!s.days.length || !s.listId} onClick={() => (lockIsNew ? setConfirming(true) : save())}>
          {s.locked && <Lock size={15} />} Save
        </button>
      </div>
      <LockWarning
        open={confirming}
        what={`Every time this schedule runs, ${list?.name ?? "its list"}`}
        until={<>until that run ends ({allDay ? "midnight" : fmtClock(s.end)})</>}
        severe={
          neverEnds ? (
            <>
              <span className="font-medium">This schedule never ends.</span> It blocks around the clock, every day of the week, so once it starts you'll never be able
              to edit or delete it again. Leave at least one gap, or turn the lock off.
            </>
          ) : undefined
        }
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          save();
        }}
      />
    </Modal>
  );
}
