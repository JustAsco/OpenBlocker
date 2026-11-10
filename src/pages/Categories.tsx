import clsx from "clsx";
import { Lock, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Page } from "../App";
import { EditorShell, ItemsEditor, useDraft } from "../components/ItemsEditor";
import { Modal, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { factoryCategory } from "../lib/catalog";
import { useStore } from "../lib/store";
import type { Category, State } from "../lib/types";
import { LIST_COLORS, fmtTime, uid } from "../lib/util";

export function CategoriesPage({ go }: { go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const { state } = snap!;
  const [selected, setSelected] = useState<string | null>(() => {
    const wanted = localStorage.getItem("ob-category");
    localStorage.removeItem("ob-category");
    return wanted ?? state.categories[0]?.id ?? null;
  });
  const category = state.categories.find((c) => c.id === selected) ?? null;

  useEffect(() => {
    if (!category && state.categories[0]) setSelected(state.categories[0].id);
  }, [category, state.categories]);

  const create = async () => {
    const c: Category = { id: uid(), name: "New category", icon: "🌐", color: LIST_COLORS[state.categories.length % LIST_COLORS.length], sites: [], apps: [] };
    if (await run(() => api.saveCategory(c))) setSelected(c.id);
  };

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="Reusable groups of websites and apps. Edit a category once and every block list that includes it updates."
        actions={
          <button className="btn-primary" onClick={create}>
            <Plus size={16} /> New category
          </button>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
        <div className="card p-2">
          {[
            { label: "Built-in", items: state.categories.filter((c) => factoryCategory(c.id)) },
            { label: "Your categories", items: state.categories.filter((c) => !factoryCategory(c.id)) },
          ]
            .filter((g) => g.items.length)
            .map((g) => (
              <div key={g.label} className="mb-1">
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{g.label}</div>
                {g.items.map((c) => {
                  const usedBy = state.lists.filter((l) => l.categories.includes(c.id)).length;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelected(c.id)}
                      className={clsx(
                        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition",
                        selected === c.id ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/50 hover:text-fg",
                      )}
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${c.color} 22%, transparent)` }}>
                        {c.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                      {usedBy > 0 && <span className="size-1.5 shrink-0 rounded-full bg-accent" title={`Used by ${usedBy} block list(s)`} />}
                      <span className="w-7 shrink-0 text-right text-xs text-faint tabular-nums">{c.sites.length + c.apps.length}</span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
        {category ? (
          <CategoryEditor key={category.id} category={category} state={state} go={go} />
        ) : (
          <div className="card grid place-items-center p-12 text-sm text-muted">No categories yet.</div>
        )}
      </div>
    </>
  );
}

function CategoryEditor({ category, state, go }: { category: Category; state: State; go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const [draft, setDraft, dirty, discard] = useDraft(category);
  const [confirm, setConfirm] = useState<"delete" | "reset" | null>(null);
  const usedBy = state.lists.filter((l) => l.categories.includes(category.id));
  const factory = factoryCategory(category.id);
  const isFactory = factory && JSON.stringify(factory) === JSON.stringify(category);

  const lockEnds = snap!.status.active
    .filter((a) => a.locked && usedBy.some((l) => l.id === a.listId))
    .reduce<number | null>((m, a) => Math.max(m ?? 0, a.endsAt), null);
  const lockedSites = useMemo(() => new Set(lockEnds ? category.sites : []), [lockEnds, category.sites]);
  const lockedApps = useMemo(() => new Set(lockEnds ? category.apps.map((a) => a.exe.toLowerCase()) : []), [lockEnds, category.apps]);

  return (
    <EditorShell
      icon={draft.icon}
      color={draft.color}
      name={draft.name}
      subtitle={
        <>
          {draft.sites.length} websites · {draft.apps.length} apps ·{" "}
          {usedBy.length ? (
            <>
              used in{" "}
              {usedBy.map((l, i) => (
                <span key={l.id}>
                  {i > 0 && ", "}
                  <button className="text-fg/80 underline decoration-line-strong underline-offset-2 hover:text-fg" onClick={() => go("lists")}>
                    {l.name}
                  </button>
                </span>
              ))}
            </>
          ) : (
            "not used by any list yet"
          )}
          {factory && !isFactory && " · customised"}
        </>
      }
      dirty={dirty}
      onName={(name) => setDraft({ ...draft, name })}
      onIcon={(icon) => setDraft({ ...draft, icon })}
      onColor={(color) => setDraft({ ...draft, color })}
      onSave={() => run(() => api.saveCategory(draft), "Saved.")}
      onDiscard={discard}
      onDelete={() => setConfirm("delete")}
      onReset={factory && !isFactory ? () => setConfirm("reset") : undefined}
      deleteDisabled={!!lockEnds}
      banner={
        <>
          {lockEnds && (
            <div className="mb-5 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <Lock size={16} className="shrink-0" />
              Used by a locked block until {fmtTime(lockEnds)}. You can add more, but can't remove anything until then.
            </div>
          )}
        </>
      }
    >
      <ItemsEditor
        sites={draft.sites}
        apps={draft.apps}
        onSites={(sites) => setDraft({ ...draft, sites })}
        onApps={(apps) => setDraft({ ...draft, apps })}
        lockedSites={lockedSites}
        lockedApps={lockedApps}
      />

      <Modal open={confirm === "delete"} onClose={() => setConfirm(null)} title={`Delete “${category.name}”?`}>
        <p className="text-sm text-muted">
          {usedBy.length
            ? `It will be removed from ${usedBy.map((l) => `“${l.name}”`).join(", ")}, which will stop blocking its ${category.sites.length} sites and ${category.apps.length} apps.`
            : "It isn't used by any block list."}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => run(() => api.deleteCategory(category.id), "Category deleted.").then(() => setConfirm(null))}>
            Delete
          </button>
        </div>
      </Modal>
      <Modal open={confirm === "reset"} onClose={() => setConfirm(null)} title="Restore built-in contents?">
        <p className="text-sm text-muted">Your changes to “{category.name}” will be replaced with the original {factory?.sites.length} sites and {factory?.apps.length} apps.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => run(() => api.saveCategory(factory!), "Restored.").then(() => setConfirm(null))}>
            Restore
          </button>
        </div>
      </Modal>
    </EditorShell>
  );
}
