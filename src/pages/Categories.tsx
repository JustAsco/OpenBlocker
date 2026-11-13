import clsx from "clsx";
import { Download, Library, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Page } from "../App";
import { EditorShell, ItemsEditor, useDraft } from "../components/ItemsEditor";
import { Modal, PageHeader, usePref } from "../components/ui";
import { api } from "../lib/api";
import { factoryCategory } from "../lib/catalog";
import { useStore } from "../lib/store";
import type { Category, State } from "../lib/types";
import { LIST_COLORS, fmtTime, uid } from "../lib/util";
import { t } from "../lib/i18n";

export function CategoriesPage({ go }: { go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const { state } = snap!;
  const [savedSelected, setSelected] = usePref<string | null>("categories-selected", null);
  // "Edit" on a category elsewhere jumps here with that category.
  useEffect(() => {
    const wanted = localStorage.getItem("ob-category");
    if (wanted) {
      localStorage.removeItem("ob-category");
      setSelected(wanted);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = state.categories.some((c) => c.id === savedSelected) ? savedSelected : (state.categories[0]?.id ?? null);
  const category = state.categories.find((c) => c.id === selected) ?? null;

  useEffect(() => {
    if (!category && state.categories[0]) setSelected(state.categories[0].id);
  }, [category, state.categories]);

  const create = async () => {
    const c: Category = { id: uid(), name: t("New category"), icon: "🌐", color: LIST_COLORS[state.categories.length % LIST_COLORS.length], sites: [], apps: [] };
    if (await run(() => api.saveCategory(c))) setSelected(c.id);
  };

  return (
    <>
      <PageHeader
        title={t("Categories")}
        subtitle={t("Reusable groups of websites and apps. Edit a category once and every block list that includes it updates.")}
        actions={
          <button className="btn-primary" onClick={create}>
            <Plus size={16} /> {t("New category")}
          </button>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
        <div className="card p-2">
          {[
            { label: t("Built-in"), items: state.categories.filter((c) => factoryCategory(c.id)) },
            { label: t("Your categories"), items: state.categories.filter((c) => !factoryCategory(c.id)) },
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
                      <span className="min-w-0 flex-1 truncate font-medium">{t(c.name)}</span>
                      {usedBy > 0 && <span className="size-1.5 shrink-0 rounded-full bg-accent" title={t("Used by {n} block list(s)", { n: usedBy })} />}
                      <span className="w-10 shrink-0 text-right text-xs text-faint tabular-nums">{fmtCount(c.sites.length + c.apps.length + (c.source?.count ?? 0))}</span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
        {category ? (
          <CategoryEditor key={category.id} category={category} state={state} go={go} />
        ) : (
          <div className="card grid place-items-center p-12 text-sm text-muted">{t("No categories yet.")}</div>
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
  // The community list is managed separately and doesn't make it "customised".
  const { source: _source, ...plain } = category;
  const isFactory = factory && JSON.stringify(factory) === JSON.stringify(plain);

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
          {t("{n} websites", { n: draft.sites.length })}
          {category.source && t(" + {n} from a community list", { n: category.source.count.toLocaleString() })} · {t("{n} apps", { n: draft.apps.length })} ·{" "}
          {usedBy.length ? (
            <>
              {t("used in")}{" "}
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
            t("not used by any list yet")
          )}
          {factory && !isFactory && t(" · customised")}
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
              {t("Used by a locked block until {time}. You can add more, but can't remove anything until then.", { time: fmtTime(lockEnds) })}
            </div>
          )}
        </>
      }
    >
      <CommunityList category={category} locked={!!lockEnds} />
      <ItemsEditor
        sites={draft.sites}
        apps={draft.apps}
        onSites={(sites) => setDraft({ ...draft, sites })}
        onApps={(apps) => setDraft({ ...draft, apps })}
        lockedSites={lockedSites}
        lockedApps={lockedApps}
      />

      <Modal open={confirm === "delete"} onClose={() => setConfirm(null)} title={t("Delete “{name}”?", { name: category.name })}>
        <p className="text-sm text-muted">
          {usedBy.length
            ? t("It will be removed from {lists}, which will stop blocking its {sites} sites and {apps} apps.", {
                lists: usedBy.map((l) => `“${l.name}”`).join(", "),
                sites: category.sites.length,
                apps: category.apps.length,
              })
            : t("It isn't used by any block list.")}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirm(null)}>
            {t("Cancel")}
          </button>
          <button className="btn-danger" onClick={() => run(() => api.deleteCategory(category.id), "Category deleted.").then(() => setConfirm(null))}>
            {t("Delete")}
          </button>
        </div>
      </Modal>
      <Modal open={confirm === "reset"} onClose={() => setConfirm(null)} title={t("Restore built-in contents?")}>
        <p className="text-sm text-muted">{t("Your changes to “{name}” will be replaced with the original {sites} sites and {apps} apps.", { name: category.name, sites: factory?.sites.length ?? 0, apps: factory?.apps.length ?? 0 })}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirm(null)}>
            {t("Cancel")}
          </button>
          <button className="btn-primary" onClick={() => run(() => api.saveCategory(factory!), "Restored.").then(() => setConfirm(null))}>
            {t("Restore")}
          </button>
        </div>
      </Modal>
    </EditorShell>
  );
}

const fmtCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

/** Well-maintained lists by Steven Black (MIT), each a few thousand to ~80,000 domains. */
const PRESETS: { name: string; url: string; size: string; forCategory: string }[] = [
  { name: "Adult websites", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts", size: "~77,000", forCategory: "adult" },
  { name: "Gambling", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts", size: "~6,700", forCategory: "gambling" },
  { name: "Social networks", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social-only/hosts", size: "~3,800", forCategory: "social" },
  { name: "Fake news", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-only/hosts", size: "~2,200", forCategory: "news" },
];

/** Import a large community domain list into a category, or update/remove it. */
function CommunityList({ category, locked }: { category: Category; locked: boolean }) {
  const { run } = useStore();
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const src = category.source;
  const load = async (url: string, name: string) => {
    setBusy(true);
    await run(() => api.importCategorySource(category.id, url, name), "Community list imported.");
    setBusy(false);
  };
  const presets = [...PRESETS].sort((a, b) => Number(b.forCategory === category.id) - Number(a.forCategory === category.id));

  return (
    <section className="mb-7 rounded-xl border border-line bg-panel p-4">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Library size={16} className="text-accent-2" /> {t("Community list")}
      </h3>
      {src ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted">
            <span className="text-fg">{src.name}</span> · {t("{n} websites · updated {date}", { n: src.count.toLocaleString(), date: new Date(src.updatedAt).toLocaleDateString() })}
          </p>
          <button className="btn-ghost py-1.5" disabled={busy} onClick={() => load(src.url, src.name)}>
            <RefreshCw size={14} className={clsx(busy && "animate-spin")} /> {t("Update")}
          </button>
          <button
            className="btn-ghost py-1.5"
            disabled={busy || locked}
            title={locked ? t("Used by a locked block") : undefined}
            onClick={() => run(() => api.removeCategorySource(category.id), "Community list removed.")}
          >
            <Trash2 size={14} /> {t("Remove")}
          </button>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            {t("Add thousands of known websites at once from a maintained list. It's downloaded once now; update it whenever you like.")}
          </p>
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            {presets.map((p) => (
              <button
                key={p.url}
                disabled={busy}
                onClick={() => load(p.url, `${t(p.name)} (Steven Black)`)}
                className={clsx(
                  "flex items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition disabled:opacity-50",
                  p.forCategory === category.id ? "border-accent/60 bg-accent/10" : "border-line bg-card hover:border-line-strong",
                )}
              >
                <Download size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t(p.name)}</span>
                  <span className="block text-xs text-muted">{t("{n} websites", { n: p.size })}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="input"
              placeholder={t("Or paste the URL of a hosts file or domain list")}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button className="btn-ghost shrink-0" disabled={busy || !/^https:\/\//.test(custom.trim())} onClick={() => load(custom.trim(), new URL(custom.trim()).hostname)}>
              {busy ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />} {t("Import")}
            </button>
          </div>
          <p className="mt-2 text-xs text-faint">{t("Lists come from GitHub (Steven Black, MIT license). Downloading is the only time OpenBlocker contacts them.")}</p>
        </>
      )}
    </section>
  );
}
