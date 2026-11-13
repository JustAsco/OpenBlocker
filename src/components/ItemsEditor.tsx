import clsx from "clsx";
import { AppWindow, ChevronDown, Globe, Lock, Package, RotateCcw, Save, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { APPS, SITES, expandSite, score, siteName } from "../lib/catalog";
import { useStore } from "../lib/store";
import type { AppEntry, InstalledApp } from "../lib/types";
import { LIST_COLORS, LIST_EMOJIS, isPathSite, normalizeSite } from "../lib/util";
import { Autocomplete, type SuggestionGroup } from "./Autocomplete";
import { AppIcon, SiteIcon } from "./ui";
import { t } from "../lib/i18n";

/**
 * Local editable copy of a server object. The backend pushes a fresh snapshot
 * every second, so we only reset the draft when the saved *content* changes —
 * never just because a new object with the same content arrived.
 */
export function useDraft<T>(server: T): [T, (t: T | ((t: T) => T)) => void, boolean, () => void] {
  const serverJson = JSON.stringify(server);
  const [draft, setDraft] = useState<T>(server);
  useEffect(() => setDraft(JSON.parse(serverJson)), [serverJson]);
  const dirty = JSON.stringify(draft) !== serverJson;
  return [draft, setDraft, dirty, () => setDraft(JSON.parse(serverJson))];
}

export function IconColorPicker({ icon, color, onIcon, onColor }: { icon: string; color: string; onIcon: (s: string) => void; onColor: (s: string) => void }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div>
        <span className="label">{t("Icon")}</span>
        <div className="flex flex-wrap gap-1">
          {LIST_EMOJIS.map((e) => (
            <button key={e} onClick={() => onIcon(e)} className={clsx("grid size-8 place-items-center rounded-lg text-base", icon === e ? "bg-elevated ring-1 ring-line-strong" : "hover:bg-elevated/60")}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">{t("Color")}</span>
        <div className="flex flex-wrap gap-2">
          {LIST_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onColor(c)}
              aria-label={c}
              className={clsx("size-7 rounded-full transition", color === c ? "ring-2 ring-white ring-offset-2 ring-offset-panel" : "hover:scale-110")}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Card with a sticky header (icon, editable name, save/discard) shared by list and category editors. */
export function EditorShell({
  icon,
  color,
  name,
  subtitle,
  dirty,
  onName,
  onIcon,
  onColor,
  onSave,
  onDiscard,
  onDelete,
  onReset,
  deleteDisabled,
  banner,
  children,
}: {
  icon: string;
  color: string;
  name: string;
  subtitle: ReactNode;
  dirty: boolean;
  onName: (s: string) => void;
  onIcon: (s: string) => void;
  onColor: (s: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
  onReset?: () => void;
  deleteDisabled?: boolean;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const [picker, setPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picker) return;
    const h = (e: MouseEvent) => !pickerRef.current?.contains(e.target as Node) && setPicker(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [picker]);
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) save.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty]);

  return (
    <div className="card">
      <div className="sticky top-0 z-40 flex items-center gap-4 rounded-t-2xl border-b border-line bg-card/95 p-5 backdrop-blur">
        <div ref={pickerRef} className="relative">
          <button
            className="grid size-12 shrink-0 place-items-center rounded-2xl text-2xl ring-line-strong transition hover:ring-2"
            style={{ background: `color-mix(in srgb, ${color} 22%, transparent)` }}
            onClick={() => setPicker(!picker)}
            title={t("Change icon & color")}
          >
            {icon}
          </button>
          {picker && (
            <div className="animate-fade-up absolute top-14 left-0 z-50 w-[420px] rounded-2xl border border-line-strong bg-panel p-4 shadow-2xl">
              <IconColorPicker icon={icon} color={color} onIcon={onIcon} onColor={onColor} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <input
            className="font-display w-full rounded-lg bg-transparent px-1 py-0.5 text-xl font-semibold outline-none hover:bg-elevated/60 focus:bg-elevated"
            value={name}
            onChange={(e) => onName(e.target.value)}
            aria-label={t("Name")}
          />
          <p className="px-1 text-sm text-muted">{subtitle}</p>
        </div>
        {dirty ? (
          <>
            <button className="btn-ghost" onClick={onDiscard}>
              <Undo2 size={16} /> {t("Discard")}
            </button>
            <button className="btn-primary" onClick={onSave} title={t("Ctrl+S")}>
              <Save size={16} /> {t("Save")}
            </button>
          </>
        ) : (
          <>
            {onReset && (
              <button className="btn-ghost px-3" onClick={onReset} title={t("Restore the built-in contents")}>
                <RotateCcw size={16} />
              </button>
            )}
            <button className="btn-ghost px-3 text-red-300" onClick={onDelete} disabled={deleteDisabled} title={t("Delete")}>
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
      <div className="p-6">
        {banner}
        {children}
      </div>
    </div>
  );
}

let installedCache: Promise<InstalledApp[]> | null = null;

/** Website + app pickers with autosuggest. */
export function ItemsEditor({
  sites,
  apps,
  onSites,
  onApps,
  lockedSites = new Set(),
  lockedApps = new Set(),
  covered,
  extraSiteGroups,
  siteTitle = "Websites",
  appTitle = "Apps",
  siteHint,
}: {
  sites: string[];
  apps: AppEntry[];
  onSites: (s: string[]) => void;
  onApps: (a: AppEntry[]) => void;
  lockedSites?: Set<string>;
  lockedApps?: Set<string>;
  /** Items already blocked through included categories (hidden from suggestions). */
  covered?: { sites: Set<string>; apps: Set<string> };
  extraSiteGroups?: (q: string) => SuggestionGroup[];
  siteTitle?: string;
  appTitle?: string;
  siteHint?: ReactNode;
}) {
  const { toast } = useStore();
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [showAll, setShowAll] = useState(false);
  const COLLAPSED = 14;
  const visibleSites = showAll ? sites : sites.slice(0, COLLAPSED);
  useEffect(() => {
    installedCache ??= api.installedApps().catch(() => []);
    installedCache.then(setInstalled);
  }, []);

  const hasSite = useCallback((d: string) => sites.includes(d) || !!covered?.sites.has(d), [sites, covered]);
  const hasApp = useCallback(
    (exe: string) => apps.some((a) => a.exe.toLowerCase() === exe.toLowerCase()) || !!covered?.apps.has(exe.toLowerCase()),
    [apps, covered],
  );

  const addSites = useCallback(
    (domains: string[]) => {
      const fresh = domains.filter((d) => !hasSite(d));
      if (!fresh.length) {
        toast("Already blocked.");
        return false;
      }
      onSites([...sites, ...fresh]);
    },
    [sites, onSites, hasSite, toast],
  );
  const addApp = useCallback(
    (a: AppEntry) => {
      if (hasApp(a.exe)) {
        toast("Already blocked.");
        return false;
      }
      onApps([...apps, a]);
    },
    [apps, onApps, hasApp, toast],
  );

  const siteGroups = useCallback(
    (q: string): SuggestionGroup[] => {
      const groups: SuggestionGroup[] = [];
      const matches = SITES.filter((s) => !hasSite(s.domain))
        .map((s) => ({ s, sc: q ? score(q, s.name, s.domain) : 1 }))
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc)
        .slice(0, q ? 8 : 6);
      const site = normalizeSite(q);
      // A pasted URL usually means the whole website; a path is offered as the second choice.
      const typed = site && site.split("/")[0];
      const typedItems = [typed, site]
        .filter((x, i, all): x is string => !!x && !hasSite(x) && all.indexOf(x) === i)
        .map((x) => ({
          key: `typed-${x}`,
          icon: <SiteIcon domain={x} />,
          title: isPathSite(x) ? t("Only {site}", { site: x }) : x,
          subtitle: isPathSite(x) ? t("Just this part of the website and everything below it · needs the browser extension") : t("The whole website, including www. and m."),
          onPick: () => addSites([x]),
        }));
      const typedGroup: SuggestionGroup | null = typedItems.length ? { label: t("Add website"), items: typedItems } : null;
      // "chess.co" is probably the start of "chess.com": prefer the known site.
      const partial = !!typed && matches.some(({ s }) => s.domain !== typed && s.domain.startsWith(typed));
      if (typedGroup && !partial) groups.push(typedGroup);
      groups.push(...(extraSiteGroups?.(q) ?? []));
      groups.push({
        label: q ? t("Suggestions") : t("Popular"),
        items: matches.map(({ s }) => ({
          key: s.domain,
          icon: <SiteIcon domain={s.domain} />,
          title: s.name,
          subtitle: expandSite(s).join(", "),
          onPick: () => addSites(expandSite(s)),
        })),
      });
      if (typedGroup && partial) groups.push(typedGroup);
      return groups;
    },
    [hasSite, addSites, extraSiteGroups],
  );

  const appGroups = useCallback(
    (q: string): SuggestionGroup[] => {
      const rank = <T,>(items: T[], f: (t: T) => string[], n: number) =>
        items
          .map((t) => ({ t, sc: q ? score(q, ...f(t)) : 1 }))
          .filter((x) => x.sc > 0)
          .sort((a, b) => b.sc - a.sc)
          .slice(0, n)
          .map((x) => x.t);
      const groups: SuggestionGroup[] = [];
      const exe = q.trim();
      if (/\.exe$/i.test(exe) && !hasApp(exe)) {
        const base = exe.split(/[\\/]/).pop()!;
        groups.push({
          label: t("Add program"),
          items: [{ key: "typed", icon: <AppWindow size={18} className="text-muted" />, title: base, subtitle: t("Closed whenever it starts"), onPick: () => addApp({ name: base.replace(/\.exe$/i, ""), exe: base }) }],
        });
      }
      const inst = installed.filter((a) => !hasApp(a.exe));
      groups.push({
        label: t("On this computer"),
        items: rank(inst, (a) => [a.name, a.exe], q ? 8 : 6).map((a) => ({
          key: `i-${a.exe}`,
          icon: <AppIcon name={a.name} exe={a.exe} path={a.path} size={20} />,
          title: a.name,
          subtitle: a.exe,
          badge: a.running ? <span className="chip border-emerald-500/30 bg-emerald-500/10 py-0 text-[10px] text-emerald-300">{t("running")}</span> : undefined,
          onPick: () => addApp({ name: a.name, exe: a.exe, path: a.path }),
        })),
      });
      const known = new Set(inst.map((a) => a.exe.toLowerCase()));
      groups.push({
        label: q ? t("Known apps") : t("Popular distractions"),
        items: rank(APPS.filter((a) => !hasApp(a.exe) && !known.has(a.exe.toLowerCase())), (a) => [a.name, a.exe], q ? 8 : 6).map((a) => ({
          key: `c-${a.exe}`,
          icon: <AppIcon name={a.name} exe={a.exe} size={20} />,
          title: a.name,
          subtitle: a.exe,
          onPick: () => addApp({ name: a.name, exe: a.exe }),
        })),
      });
      return groups;
    },
    [installed, hasApp, addApp],
  );

  return (
    <>
      <section className="mb-7">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Globe size={16} className="text-accent-2" /> {siteTitle}
          <span className="font-normal text-faint">{sites.length}</span>
        </h3>
        {siteHint}
        <Autocomplete placeholder={t("Search or paste a URL — e.g. “youtube”, “reddit.com” or “youtube.com/shorts”")} getGroups={siteGroups} />
        <div className="mt-3 flex flex-wrap gap-2">
          {visibleSites.map((d) => (
            <span key={d} className="chip py-1.5 pr-1.5 pl-2 text-sm">
              <SiteIcon domain={d} size={16} />
              <span>{d}</span>
              {siteName(d) && <span className="text-xs text-faint">{siteName(d)}</span>}
              {isPathSite(d) && (
                <span className="text-xs text-faint" title={t("Only this part of the website. Blocked by the browser extension; without it the page stays reachable.")}>
                  {t("part · needs extension")}
                </span>
              )}
              {lockedSites.has(d) ? (
                <Lock size={12} className="mx-1 text-faint" />
              ) : (
                <button className="rounded p-0.5 text-faint hover:bg-line hover:text-fg" onClick={() => onSites(sites.filter((s) => s !== d))} aria-label={`Remove ${d}`}>
                  <X size={13} />
                </button>
              )}
            </span>
          ))}
          {sites.length > COLLAPSED && (
            <button className="chip py-1.5 text-sm text-muted hover:text-fg" onClick={() => setShowAll(!showAll)}>
              <ChevronDown size={14} className={clsx("transition", showAll && "rotate-180")} />
              {showAll ? t("Show less") : t("Show all {n}", { n: sites.length })}
            </button>
          )}
          {!sites.length && <p className="text-sm text-faint">{t("None yet — start typing above.")}</p>}
        </div>
      </section>

      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Package size={16} className="text-accent" /> {appTitle}
          <span className="font-normal text-faint">{apps.length}</span>
        </h3>
        <Autocomplete placeholder={t("Search installed apps or type a program name (e.g. steam.exe)")} getGroups={appGroups} />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {apps.map((a) => (
            <div key={a.exe} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-2.5">
              <AppIcon name={a.name} exe={a.exe} path={a.path} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="truncate text-xs text-muted">{a.exe}</div>
              </div>
              {lockedApps.has(a.exe.toLowerCase()) ? (
                <Lock size={13} className="mx-1.5 text-faint" />
              ) : (
                <button className="rounded-lg p-1 text-faint hover:bg-line hover:text-fg" onClick={() => onApps(apps.filter((x) => x.exe !== a.exe))} aria-label={`Remove ${a.name}`}>
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
          {!apps.length && <p className="text-sm text-faint">{t("None yet.")}</p>}
        </div>
      </section>
    </>
  );
}
