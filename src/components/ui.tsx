import clsx from "clsx";
import { CheckCircle2, Info, Lock, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, isTauri } from "../lib/api";
import { useStore } from "../lib/store";
import type { BlockList } from "../lib/types";

// ─── preferences stored only in the UI ───────────────────────────────

export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`ob-pref-${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(`ob-pref-${key}`, JSON.stringify(nv));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent("ob-pref", { detail: key }));
  };
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent).detail === key) {
        try {
          const raw = localStorage.getItem(`ob-pref-${key}`);
          if (raw !== null) setV(JSON.parse(raw));
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("ob-pref", h);
    return () => window.removeEventListener("ob-pref", h);
  }, [key]);
  return [v, set];
}

// ─── icons ──────────────────────────────────────────────────────────

function hashColor(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function Letter({ text, size }: { text: string; size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md font-semibold text-white"
      style={{ width: size, height: size, background: hashColor(text), fontSize: size * 0.5 }}
    >
      {text.replace(/^www\./, "").charAt(0).toUpperCase()}
    </span>
  );
}

export function SiteIcon({ domain, size = 18 }: { domain: string; size?: number }) {
  const [load] = usePref("site-icons", true);
  const [failed, setFailed] = useState(false);
  // Entries can be parts of a site ("youtube.com/shorts"): use the domain's icon.
  const host = domain.split("/")[0];
  if (!load || failed) return <Letter text={host} size={size} />;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
      width={size}
      height={size}
      alt=""
      className="shrink-0 rounded-md bg-white/5"
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
    />
  );
}

const iconCache = new Map<string, Promise<string | null>>();

export function AppIcon({ name, path, size = 18 }: { name: string; path?: string | null; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !isTauri) return;
    let alive = true;
    if (!iconCache.has(path)) iconCache.set(path, api.appIcon(path).catch(() => null));
    iconCache.get(path)!.then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [path]);
  if (src) return <img src={src} width={size} height={size} alt="" className="shrink-0" />;
  return <Letter text={name} size={size} />;
}

export function ListBadge({ list, className }: { list: BlockList; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-sm", className)}>
      <span
        className="grid size-6 place-items-center rounded-lg text-sm"
        style={{ background: `color-mix(in srgb, ${list.color} 22%, transparent)` }}
      >
        {list.icon}
      </span>
      <span className="truncate font-medium">{list.name}</span>
    </span>
  );
}

// ─── controls ───────────────────────────────────────────────────────

/** On/off switch. `lockedOn`: it's on and can't be turned off right now (a lock is running). */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  lockedOn,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  lockedOn?: boolean;
}) {
  const frozen = !!lockedOn && checked;
  return (
    <label className={clsx("flex items-start justify-between gap-6 py-3", frozen ? "cursor-not-allowed" : "cursor-pointer")}>
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {frozen && <Lock size={12} className="text-amber-400" aria-label="Can't be turned off while a locked block is running" />}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={frozen}
        title={frozen ? "Can't be turned off while a locked block is running" : undefined}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition disabled:opacity-60",
          checked ? "border-transparent bg-accent" : "border-line-strong bg-elevated",
        )}
      >
        <span className={clsx("absolute top-0.5 size-[18px] rounded-full bg-white shadow transition-all", checked ? "left-[22px]" : "left-0.5")} />
      </button>
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  className?: string;
}) {
  return (
    <div className={clsx("inline-flex rounded-xl border border-line bg-panel p-1", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={clsx(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40",
            value === o.value ? "bg-elevated text-fg shadow ring-1 ring-line-strong" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Open modals, innermost last: Escape only closes the topmost one. */
const modalStack: object[] = [];

export function Modal({ open, onClose, title, children, width = 480 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = {};
    modalStack.push(me);
    const h = (e: KeyboardEvent) => e.key === "Escape" && modalStack[modalStack.length - 1] === me && close.current();
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      modalStack.splice(modalStack.indexOf(me), 1);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="card animate-fade-up max-h-[90vh] w-full overflow-auto bg-panel p-6 shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button className="rounded-lg p-1 text-muted hover:bg-elevated hover:text-fg" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A button that must be held down — prevents impulsive clicks. */
export function HoldButton({ onConfirm, children, ms = 1500, className }: { onConfirm: () => void; children: ReactNode; ms?: number; className?: string }) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<number | null>(null);
  const start = () => {
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      setProgress(p);
      if (p >= 1) {
        stop();
        onConfirm();
      } else timer.current = requestAnimationFrame(step);
    };
    timer.current = requestAnimationFrame(step);
  };
  const stop = () => {
    if (timer.current) cancelAnimationFrame(timer.current);
    timer.current = null;
    setProgress(0);
  };
  return (
    <button
      type="button"
      className={clsx("relative overflow-hidden", className)}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !timer.current && start()}
      onKeyUp={stop}
    >
      <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${progress * 100}%` }} />
      <span className="relative flex items-center gap-2">{children}</span>
    </button>
  );
}

export function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "animate-fade-up pointer-events-auto flex items-start gap-3 rounded-xl border bg-panel/95 px-4 py-3 text-sm shadow-2xl backdrop-blur",
            t.kind === "error" ? "border-red-500/40" : t.kind === "success" ? "border-emerald-500/40" : "border-line-strong",
          )}
        >
          {t.kind === "error" ? (
            <XCircle size={18} className="mt-px shrink-0 text-red-400" />
          ) : t.kind === "success" ? (
            <CheckCircle2 size={18} className="mt-px shrink-0 text-emerald-400" />
          ) : (
            <Info size={18} className="mt-px shrink-0 text-cyan-400" />
          )}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
