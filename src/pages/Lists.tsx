import clsx from "clsx";
import { Check, Lock, Pencil, Plus, Tags } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Page } from "../App";
import type { SuggestionGroup } from "../components/Autocomplete";
import { EditorShell, IconColorPicker, ItemsEditor, useDraft } from "../components/ItemsEditor";
import { Modal, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { score } from "../lib/catalog";
import { useStore } from "../lib/store";
import type { BlockList, Category, State } from "../lib/types";
import { LIST_COLORS, fmtTime, listTargets, uid } from "../lib/util";

/** Remember which category to open when jumping to the Categories page. */
export const openCategory = (id: string, go: (p: Page) => void) => {
  localStorage.setItem("ob-category", id);
  go("categories");
};

export function ListsPage({ go }: { go: (p: Page) => void }) {
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
        subtitle="What gets blocked together. Include whole categories and add your own extras. Use lists in quick blocks, schedules and focus sessions."
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New list
          </button>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-2">
          {state.lists.map((l) => {
            const active = status.active.some((a) => a.listId === l.id);
            const t = listTargets(state, l);
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
                    {t.sites.size} sites · {t.apps.size} apps
                  </span>
                </span>
                {active && <span className="pulse-dot size-2 shrink-0 rounded-full bg-good" title="Active now" />}
              </button>
            );
          })}
          {state.lists.length === 0 && <p className="p-4 text-sm text-muted">No lists yet.</p>}
        </div>
        {list ? (
          <ListEditor key={list.id} list={list} state={state} go={go} />
        ) : (
          <div className="card grid place-items-center p-12 text-sm text-muted">Create your first block list to get started.</div>
        )}
      </div>
      <NewListModal
        open={creating}
        categories={state.categories}
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

function CategoryToggle({ c, on, locked, onToggle, onEdit }: { c: Category; on: boolean; locked: boolean; onToggle: () => void; onEdit: () => void }) {
  return (
    <div
      className={clsx(
        "group relative flex items-center gap-2.5 rounded-xl border p-2.5 transition",
        on ? "border-transparent" : "border-line bg-panel hover:border-line-strong",
      )}
      style={on ? { background: `color-mix(in srgb, ${c.color} 16%, transparent)`, boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={onToggle} disabled={on && locked} title={on && locked ? "Locked while a block is running" : undefined}>
        <span className={clsx("grid size-5 shrink-0 place-items-center rounded-md border", on ? "border-transparent text-white" : "border-line-strong")} style={on ? { background: c.color } : undefined}>
          {on && (locked ? <Lock size={11} /> : <Check size={13} strokeWidth={3} />)}
        </span>
        <span className="text-base">{c.icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{c.name}</span>
          <span className="block text-[11px] text-muted">
            {c.sites.length} sites · {c.apps.length} apps
          </span>
        </span>
      </button>
      <button className="rounded-lg p-1.5 text-faint opacity-0 transition group-hover:opacity-100 hover:bg-line hover:text-fg focus:opacity-100" onClick={onEdit} title={`Edit “${c.name}”`}>
        <Pencil size={13} />
      </button>
    </div>
  );
}

function ListEditor({ list, state, go }: { list: BlockList; state: State; go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const [draft, setDraft, dirty, discard] = useDraft(list);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const lockBlock = snap!.status.active.filter((a) => a.listId === list.id && a.locked).sort((a, b) => b.endsAt - a.endsAt)[0];
  const lockedSites = useMemo(() => new Set(lockBlock ? list.sites : []), [lockBlock, list.sites]);
  const lockedApps = useMemo(() => new Set(lockBlock ? list.apps.map((a) => a.exe.toLowerCase()) : []), [lockBlock, list.apps]);
  const total = listTargets(state, draft);
  const covered = useMemo(() => {
    const t = listTargets(state, { ...draft, sites: [], apps: [] });
    return { sites: t.sites, apps: new Set(t.apps.keys()) };
  }, [state, draft]);

  const toggleCategory = useCallback(
    (id: string) => setDraft((d) => ({ ...d, categories: d.categories.includes(id) ? d.categories.filter((c) => c !== id) : [...d.categories, id] })),
    [setDraft],
  );

  const categoryGroups = useCallback(
    (q: string): SuggestionGroup[] => [
      {
        label: "Include a whole category",
        items: state.categories
          .filter((c) => !draft.categories.includes(c.id) && (!q || score(q, c.name) > 0))
          .map((c) => ({
            key: `cat-${c.id}`,
            icon: <span className="text-base">{c.icon}</span>,
            title: c.name,
            subtitle: `${c.sites.length} sites · ${c.apps.length} apps — stays in sync when you edit the category`,
            onPick: () => toggleCategory(c.id),
          })),
      },
    ],
    [state.categories, draft.categories, toggleCategory],
  );

  return (
    <EditorShell
      icon={draft.icon}
      color={draft.color}
      name={draft.name}
      subtitle={`${total.sites.size} websites · ${total.apps.size} apps blocked in total`}
      dirty={dirty}
      onName={(name) => setDraft({ ...draft, name })}
      onIcon={(icon) => setDraft({ ...draft, icon })}
      onColor={(color) => setDraft({ ...draft, color })}
      onSave={() => run(() => api.saveList(draft), "Saved.")}
      onDiscard={discard}
      onDelete={() => setConfirmDelete(true)}
      deleteDisabled={!!lockBlock}
      banner={
        lockBlock && (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <Lock size={16} className="shrink-0" />
            Locked until {fmtTime(lockBlock.endsAt)}. You can add more, but can't remove anything until then.
          </div>
        )
      }
    >
      <section className="mb-7">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Tags size={16} className="text-pink-400" /> Categories
          </h3>
          <button className="text-xs text-muted hover:text-fg" onClick={() => go("categories")}>
            Manage categories →
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
          {state.categories.map((c) => (
            <CategoryToggle
              key={c.id}
              c={c}
              on={draft.categories.includes(c.id)}
              locked={!!lockBlock && list.categories.includes(c.id)}
              onToggle={() => toggleCategory(c.id)}
              onEdit={() => openCategory(c.id, go)}
            />
          ))}
        </div>
      </section>

      <ItemsEditor
        siteTitle="Extra websites"
        appTitle="Extra apps"
        sites={draft.sites}
        apps={draft.apps}
        onSites={(sites) => setDraft({ ...draft, sites })}
        onApps={(apps) => setDraft({ ...draft, apps })}
        lockedSites={lockedSites}
        lockedApps={lockedApps}
        covered={covered}
        extraSiteGroups={categoryGroups}
      />

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${list.name}”?`}>
        <p className="text-sm text-muted">This also removes its schedules and running quick blocks. Categories are kept.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => run(() => api.deleteList(list.id), "List deleted.").then(() => setConfirmDelete(false))}>
            Delete
          </button>
        </div>
      </Modal>
    </EditorShell>
  );
}

function NewListModal({ open, categories, onClose, onCreate }: { open: boolean; categories: Category[]; onClose: () => void; onCreate: (l: BlockList) => void }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("⛔");
  const [color, setColor] = useState(LIST_COLORS[0]);
  const [cats, setCats] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setName("");
      setCats([]);
    }
  }, [open]);

  const toggle = (c: Category) => {
    const next = cats.includes(c.id) ? cats.filter((x) => x !== c.id) : [...cats, c.id];
    setCats(next);
    // First pick suggests name, icon and color.
    if (next.length === 1 && !name) {
      setName(c.name);
      setIcon(c.icon);
      setColor(c.color);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New block list" width={600}>
      <span className="label">Include categories</span>
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {categories.map((c) => (
          <button
            key={c.id}
            className={clsx("flex items-center gap-2 rounded-xl border p-2.5 text-left text-sm", cats.includes(c.id) ? "border-accent bg-accent/10" : "border-line bg-card hover:border-line-strong")}
            onClick={() => toggle(c)}
          >
            <span>{c.icon}</span>
            <span className="truncate">{c.name}</span>
            {cats.includes(c.id) && <Check size={14} className="ml-auto shrink-0 text-accent" />}
          </button>
        ))}
      </div>
      <span className="label">Name</span>
      <input className="input mb-5" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Evening distractions" autoFocus />
      <IconColorPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
      <p className="mt-4 text-xs text-muted">You can add individual websites and apps after creating the list.</p>
      <div className="mt-6 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!name.trim()} onClick={() => onCreate({ id: uid(), name: name.trim(), icon, color, sites: [], apps: [], categories: cats })}>
          Create list
        </button>
      </div>
    </Modal>
  );
}
