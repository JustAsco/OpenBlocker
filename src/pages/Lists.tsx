import clsx from "clsx";
import { AppWindow, Globe, Lock, Package, Plus, Save, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Autocomplete, type SuggestionGroup } from "../components/Autocomplete";
import { AppIcon, Modal, PageHeader, SiteIcon } from "../components/ui";
import { api } from "../lib/api";
import { APPS, CATEGORIES, SITES, expandSite, score, siteName, type CategoryId } from "../lib/catalog";
import { useStore } from "../lib/store";
import type { AppEntry, BlockList, InstalledApp } from "../lib/types";
import { LIST_COLORS, LIST_EMOJIS, fmtTime, normalizeDomain } from "../lib/util";

export function ListsPage() {
  const { snap, run } = useStore();
  const { state, status } = snap!;
  const [selected, setSelected] = useState<string | null>(state.lists[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const list = state.lists.find((l) => l.id === selected) ?? null;

  useEffect(() => {
    if (!list && state.lists[0]) setSelected(state.lists[0].id);
  }, [list, state.lists]);

  return (
    <>
      <PageHeader
        title="Block lists"
        subtitle="Group websites and apps you want to block together. Use them in quick blocks, schedules and focus sessions."
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New list
          </button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-2">
          {state.lists.map((l) => {
            const active = status.active.some((a) => a.listId === l.id);
            return (
              <button
                key={l.id}
                onClick={() => setSelected(l.id)}
                className={clsx(
                  "flex items-center gap-3 rounded-2xl border p-3 text-left transition",
                  selected === l.id ? "border-line-strong bg-elevated" : "border-line bg-card hover:border-line-strong",
                )}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl text-lg" style={{ background: `color-mix(in srgb, ${l.color} 22%, transparent)` }}>
                  {l.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{l.name}</span>
                  <span className="text-xs text-muted">
                    {l.sites.length} sites · {l.apps.length} apps
                  </span>
                </span>
                {active && <span className="pulse-dot size-2 shrink-0 rounded-full bg-good" title="Active now" />}
              </button>
            );
          })}
          {state.lists.length === 0 && <p className="p-4 text-sm text-muted">No lists yet.</p>}
        </div>
        {list ? (
          <ListEditor key={list.id} list={list} />
        ) : (
          <div className="card grid place-items-center p-12 text-sm text-muted">Create your first block list to get started.</div>
        )}
      </div>
      <NewListModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={async (l) => {
          if (await run(() => api.saveList(l), `“${l.name}” created.`)) {
            setSelected(l.id);
            setCreating(false);
          }
        }}
      />
    </>
  );
}

function NewListModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (l: BlockList) => void }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("⛔");
  const [color, setColor] = useState(LIST_COLORS[0]);
  const [template, setTemplate] = useState<CategoryId | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setTemplate(null);
    }
  }, [open]);

  const pickTemplate = (c: CategoryId | null) => {
    setTemplate(c);
    if (c) {
      setName(CATEGORIES[c].name);
      setIcon(CATEGORIES[c].emoji);
      setColor(CATEGORIES[c].color);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New block list" width={560}>
      <span className="label">Start from</span>
      <div className="mb-5 grid grid-cols-3 gap-2">
        <button
          className={clsx("rounded-xl border p-3 text-left text-sm", template === null ? "border-accent bg-accent/10" : "border-line bg-card hover:border-line-strong")}
          onClick={() => pickTemplate(null)}
        >
          ✨ Empty
        </button>
        {(Object.keys(CATEGORIES) as CategoryId[]).map((c) => (
          <button
            key={c}
            className={clsx("rounded-xl border p-3 text-left text-sm", template === c ? "border-accent bg-accent/10" : "border-line bg-card hover:border-line-strong")}
            onClick={() => pickTemplate(c)}
          >
            {CATEGORIES[c].emoji} {CATEGORIES[c].name}
          </button>
        ))}
      </div>
      <span className="label">Name</span>
      <input className="input mb-5" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Evening distractions" autoFocus />
      <IconColorPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
      <div className="mt-6 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={!name.trim()}
          onClick={() =>
            onCreate({
              id: crypto.randomUUID(),
              name: name.trim(),
              icon,
              color,
              sites: template ? SITES.filter((s) => s.category === template).flatMap(expandSite) : [],
              apps: template ? APPS.filter((a) => a.category === template).map(({ name, exe }) => ({ name, exe })) : [],
            })
          }
        >
          Create list
        </button>
      </div>
    </Modal>
  );
}

function IconColorPicker({ icon, color, onIcon, onColor }: { icon: string; color: string; onIcon: (s: string) => void; onColor: (s: string) => void }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div>
        <span className="label">Icon</span>
        <div className="flex flex-wrap gap-1">
          {LIST_EMOJIS.map((e) => (
            <button key={e} onClick={() => onIcon(e)} className={clsx("grid size-8 place-items-center rounded-lg text-base", icon === e ? "bg-elevated ring-1 ring-line-strong" : "hover:bg-elevated/60")}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Color</span>
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

let installedCache: Promise<InstalledApp[]> | null = null;

function ListEditor({ list }: { list: BlockList }) {
  const { snap, run, toast } = useStore();
  const [draft, setDraft] = useState<BlockList>(list);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setDraft(list), [list]);
  useEffect(() => {
    installedCache ??= api.installedApps().catch(() => []);
    installedCache.then(setInstalled);
  }, []);

  const lockBlock = snap!.status.active.filter((a) => a.listId === list.id && a.locked).sort((a, b) => b.endsAt - a.endsAt)[0];
  const lockedSites = useMemo(() => new Set(lockBlock ? list.sites : []), [lockBlock, list.sites]);
  const lockedApps = useMemo(() => new Set(lockBlock ? list.apps.map((a) => a.exe.toLowerCase()) : []), [lockBlock, list.apps]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(list);

  const addSites = useCallback(
    (domains: string[]) => {
      const fresh = domains.filter((d) => !draft.sites.includes(d));
      if (!fresh.length) {
        toast("Already in this list.");
        return false;
      }
      setDraft((d) => ({ ...d, sites: [...d.sites, ...fresh] }));
    },
    [draft.sites, toast],
  );
  const addApp = useCallback(
    (a: AppEntry) => {
      if (draft.apps.some((x) => x.exe.toLowerCase() === a.exe.toLowerCase())) {
        toast("Already in this list.");
        return false;
      }
      setDraft((d) => ({ ...d, apps: [...d.apps, a] }));
    },
    [draft.apps, toast],
  );

  const siteGroups = useCallback(
    (q: string): SuggestionGroup[] => {
      const groups: SuggestionGroup[] = [];
      const typed = normalizeDomain(q);
      if (typed && !draft.sites.includes(typed)) {
        groups.push({
          label: "Add website",
          items: [{ key: "typed", icon: <SiteIcon domain={typed} />, title: typed, subtitle: "Also blocks www. and m. subdomains", onPick: () => addSites([typed]) }],
        });
      }
      const matches = SITES.filter((s) => !draft.sites.includes(s.domain))
        .map((s) => ({ s, sc: q ? score(q, s.name, s.domain) : 1 }))
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc)
        .slice(0, q ? 8 : 6);
      groups.push({
        label: q ? "Suggestions" : "Popular",
        items: matches.map(({ s }) => ({
          key: s.domain,
          icon: <SiteIcon domain={s.domain} />,
          title: s.name,
          subtitle: expandSite(s).join(", "),
          badge: <span className="text-xs text-faint">{CATEGORIES[s.category].emoji}</span>,
          onPick: () => addSites(expandSite(s)),
        })),
      });
      const cats = (Object.keys(CATEGORIES) as CategoryId[]).filter((c) => !q || score(q, CATEGORIES[c].name, c) > 0);
      groups.push({
        label: "Add a whole category",
        items: cats.map((c) => {
          const domains = SITES.filter((s) => s.category === c).flatMap(expandSite);
          const missing = domains.filter((d) => !draft.sites.includes(d));
          return {
            key: `cat-${c}`,
            icon: <span className="text-base">{CATEGORIES[c].emoji}</span>,
            title: CATEGORIES[c].name,
            subtitle: missing.length ? `${missing.length} sites` : "All added",
            onPick: () => addSites(domains),
          };
        }).filter((i) => i.subtitle !== "All added" && i.subtitle !== "0 sites"),
      });
      return groups;
    },
    [draft.sites, addSites],
  );

  const appGroups = useCallback(
    (q: string): SuggestionGroup[] => {
      const has = (exe: string) => draft.apps.some((a) => a.exe.toLowerCase() === exe.toLowerCase());
      const rank = <T,>(items: T[], f: (t: T) => string[], n: number) =>
        items
          .map((t) => ({ t, sc: q ? score(q, ...f(t)) : 1 }))
          .filter((x) => x.sc > 0)
          .sort((a, b) => b.sc - a.sc)
          .slice(0, n)
          .map((x) => x.t);
      const groups: SuggestionGroup[] = [];
      const exe = q.trim();
      if (/\.exe$/i.test(exe) && !has(exe)) {
        const base = exe.split(/[\\/]/).pop()!;
        groups.push({
          label: "Add program",
          items: [{ key: "typed", icon: <AppWindow size={18} className="text-muted" />, title: base, subtitle: "Closed whenever it starts", onPick: () => addApp({ name: base.replace(/\.exe$/i, ""), exe: base }) }],
        });
      }
      const inst = installed.filter((a) => !has(a.exe));
      groups.push({
        label: "On this computer",
        items: rank(inst, (a) => [a.name, a.exe], q ? 8 : 6).map((a) => ({
          key: `i-${a.exe}`,
          icon: <AppIcon name={a.name} path={a.path} size={20} />,
          title: a.name,
          subtitle: a.exe,
          badge: a.running ? <span className="chip border-emerald-500/30 bg-emerald-500/10 py-0 text-[10px] text-emerald-300">running</span> : undefined,
          onPick: () => addApp({ name: a.name, exe: a.exe, path: a.path }),
        })),
      });
      const known = new Set(inst.map((a) => a.exe.toLowerCase()));
      groups.push({
        label: q ? "Known apps" : "Popular distractions",
        items: rank(APPS.filter((a) => !has(a.exe) && !known.has(a.exe.toLowerCase())), (a) => [a.name, a.exe, CATEGORIES[a.category].name], q ? 8 : 6).map((a) => ({
          key: `c-${a.exe}`,
          icon: <AppIcon name={a.name} size={20} />,
          title: a.name,
          subtitle: a.exe,
          badge: <span className="text-xs text-faint">{CATEGORIES[a.category].emoji}</span>,
          onPick: () => addApp({ name: a.name, exe: a.exe }),
        })),
      });
      return groups;
    },
    [draft.apps, installed, addApp],
  );

  return (
    <div className="card p-6">
      <div className="mb-6 flex items-start gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl text-2xl" style={{ background: `color-mix(in srgb, ${draft.color} 22%, transparent)` }}>
          {draft.icon}
        </span>
        <div className="min-w-0 flex-1">
          <input
            className="font-display w-full rounded-lg bg-transparent px-1 py-0.5 text-xl font-semibold outline-none hover:bg-elevated/60 focus:bg-elevated"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <p className="px-1 text-sm text-muted">
            {draft.sites.length} websites · {draft.apps.length} apps
          </p>
        </div>
        <button className="btn-ghost px-3 text-red-300" onClick={() => setConfirmDelete(true)} disabled={!!lockBlock} title="Delete list">
          <Trash2 size={16} />
        </button>
      </div>

      {lockBlock && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <Lock size={16} className="shrink-0" />
          Locked until {fmtTime(lockBlock.endsAt)}. You can add more, but can't remove anything until then.
        </div>
      )}

      <details className="mb-6 rounded-xl border border-line bg-panel/50 p-4">
        <summary className="cursor-pointer text-sm text-muted select-none">Icon &amp; color</summary>
        <div className="mt-4">
          <IconColorPicker icon={draft.icon} color={draft.color} onIcon={(icon) => setDraft({ ...draft, icon })} onColor={(color) => setDraft({ ...draft, color })} />
        </div>
      </details>

      <section className="mb-7">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Globe size={16} className="text-accent-2" /> Websites
        </h3>
        <Autocomplete placeholder="Search or paste a URL — e.g. “youtube”, “https://reddit.com/r/all”" getGroups={siteGroups} />
        <div className="mt-3 flex flex-wrap gap-2">
          {draft.sites.map((d) => (
            <span key={d} className="chip py-1.5 pr-1.5 pl-2 text-sm">
              <SiteIcon domain={d} size={16} />
              <span>{d}</span>
              {siteName(d) && <span className="text-xs text-faint">{siteName(d)}</span>}
              {lockedSites.has(d) ? (
                <Lock size={12} className="mx-1 text-faint" />
              ) : (
                <button className="rounded p-0.5 text-faint hover:bg-line hover:text-fg" onClick={() => setDraft({ ...draft, sites: draft.sites.filter((s) => s !== d) })} aria-label={`Remove ${d}`}>
                  <X size={13} />
                </button>
              )}
            </span>
          ))}
          {!draft.sites.length && <p className="text-sm text-faint">No websites yet — start typing above.</p>}
        </div>
      </section>

      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Package size={16} className="text-accent" /> Apps
        </h3>
        <Autocomplete placeholder="Search installed apps or type a program name (e.g. steam.exe)" getGroups={appGroups} />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {draft.apps.map((a) => (
            <div key={a.exe} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-2.5">
              <AppIcon name={a.name} path={a.path} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="truncate text-xs text-muted">{a.exe}</div>
              </div>
              {lockedApps.has(a.exe.toLowerCase()) ? (
                <Lock size={13} className="mx-1.5 text-faint" />
              ) : (
                <button className="rounded-lg p-1 text-faint hover:bg-line hover:text-fg" onClick={() => setDraft({ ...draft, apps: draft.apps.filter((x) => x.exe !== a.exe) })} aria-label={`Remove ${a.name}`}>
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
          {!draft.apps.length && <p className="text-sm text-faint">No apps yet.</p>}
        </div>
      </section>

      <div className={clsx("sticky bottom-4 mt-8 flex justify-end gap-2 transition", dirty ? "opacity-100" : "pointer-events-none opacity-0")}>
        <div className="flex gap-2 rounded-2xl border border-line-strong bg-panel/95 p-2 shadow-2xl backdrop-blur">
          <button className="btn-ghost" onClick={() => setDraft(list)}>
            <Undo2 size={16} /> Discard
          </button>
          <button className="btn-primary" onClick={() => run(() => api.saveList(draft), "Saved.")}>
            <Save size={16} /> Save changes
          </button>
        </div>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${list.name}”?`}>
        <p className="text-sm text-muted">This also removes its schedules and running quick blocks.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => run(() => api.deleteList(list.id), "List deleted.").then(() => setConfirmDelete(false))}>
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
