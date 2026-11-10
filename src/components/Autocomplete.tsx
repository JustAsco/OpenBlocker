import clsx from "clsx";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface Suggestion {
  key: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  /** Return false to keep the query text (e.g. when the pick failed). */
  onPick: () => void | boolean;
}

export interface SuggestionGroup {
  label: string;
  items: Suggestion[];
}

/** Search box with a keyboard-navigable suggestion dropdown. */
export function Autocomplete({
  placeholder,
  getGroups,
}: {
  placeholder: string;
  getGroups: (query: string) => SuggestionGroup[];
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => getGroups(q).filter((g) => g.items.length), [getGroups, q]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (s: Suggestion) => {
    if (s.onPick() !== false) setQ("");
    // Close after picking so the dropdown doesn't cover the rest of the page;
    // clicking or typing in the box opens it again.
    setOpen(false);
  };

  let idx = -1;
  return (
    <div ref={box} className="relative">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
        <input
          className="input pl-9"
          placeholder={placeholder}
          value={q}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(flat.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && open && flat[active]) {
              e.preventDefault();
              pick(flat[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
      </div>
      {open && flat.length > 0 && (
        <div
          ref={listRef}
          className="animate-fade-up absolute z-30 mt-2 max-h-80 w-full overflow-auto rounded-xl border border-line-strong bg-panel p-1.5 shadow-2xl"
        >
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{g.label}</div>
              {g.items.map((s) => {
                idx++;
                const i = idx;
                return (
                  <button
                    key={s.key}
                    data-idx={i}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(s)}
                    className={clsx(
                      "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm",
                      i === active ? "bg-elevated" : "hover:bg-elevated/60",
                    )}
                  >
                    <span className="grid size-6 shrink-0 place-items-center">{s.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{s.title}</span>
                      {s.subtitle && <span className="block truncate text-xs text-muted">{s.subtitle}</span>}
                    </span>
                    {s.badge}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
