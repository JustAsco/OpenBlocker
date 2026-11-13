import clsx from "clsx";
import { AppWindow, Ban, Check, CircleCheck, CircleMinus, ExternalLink, Lock, Pencil, Plus, Puzzle, Tags, MonitorPlay, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Page } from "../App";
import type { SuggestionGroup } from "../components/Autocomplete";
import { EditorShell, IconColorPicker, ItemsEditor, useDraft } from "../components/ItemsEditor";
import { AppIcon, Modal, PageHeader, Segmented, Toggle, usePref } from "../components/ui";
import { api } from "../lib/api";
import { score } from "../lib/catalog";
import { useStore } from "../lib/store";
import type { BlockList, BrowserSeen, Category, ListMode, State } from "../lib/types";
import { LIST_COLORS, fmtTime, isPathSite, listTargets, normalizeChannel, uid } from "../lib/util";
import { t, tx } from "../lib/i18n";

/** Remember which category to open when jumping to the Categories page. */
export const openCategory = (id: string, go: (p: Page) => void) => {
  localStorage.setItem("ob-category", id);
  go("categories");
};

export function ListsPage({ go }: { go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const { state, status } = snap!;
  const [savedSelected, setSelected] = usePref<string | null>("lists-selected", null);
  const selected = state.lists.some((l) => l.id === savedSelected) ? savedSelected : (state.lists[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const list = state.lists.find((l) => l.id === selected) ?? null;

  useEffect(() => {
    if (!list && state.lists[0]) setSelected(state.lists[0].id);
  }, [list, state.lists]);

  return (
    <>
      <PageHeader
        title={t("Block lists")}
        subtitle={t("What gets blocked together. Include whole categories and add your own extras. Use lists in quick blocks, schedules and focus sessions.")}
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> {t("New list")}
          </button>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-2">
          {state.lists.map((l) => {
            const active = status.active.some((a) => a.listId === l.id);
            const targets = listTargets(state, l);
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
                    {t("{sites} sites · {apps} apps", { sites: targets.sites.size, apps: targets.apps.size })}
                  </span>
                </span>
                {active && <span className="pulse-dot size-2 shrink-0 rounded-full bg-good" title={t("Active now")} />}
              </button>
            );
          })}
          {state.lists.length === 0 && <p className="p-4 text-sm text-muted">{t("No lists yet.")}</p>}
        </div>
        {list ? (
          <ListEditor key={list.id} list={list} state={state} go={go} />
        ) : (
          <div className="card grid place-items-center p-12 text-sm text-muted">{t("Create your first block list to get started.")}</div>
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

function CategoryPill({ c, on, locked, onToggle, onEdit }: { c: Category; on: boolean; locked: boolean; onToggle: () => void; onEdit: () => void }) {
  return (
    <span
      className={clsx("group inline-flex items-center rounded-full border text-sm transition", on ? "border-transparent" : "border-line bg-panel hover:border-line-strong")}
      style={on ? { background: `color-mix(in srgb, ${c.color} 20%, transparent)`, boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
    >
      <button
        className={clsx("inline-flex items-center gap-1.5 py-1.5 pr-1 pl-2.5", on ? "text-fg" : "text-muted hover:text-fg")}
        onClick={onToggle}
        disabled={on && locked}
        title={on && locked ? t("Locked while a block is running") : `${c.sites.length} sites · ${c.apps.length} apps`}
      >
        {on ? locked ? <Lock size={13} /> : <Check size={14} strokeWidth={3} style={{ color: c.color }} /> : <Plus size={14} className="text-faint" />}
        <span>{c.icon}</span>
        {t(c.name)}
        <span className="text-xs text-faint tabular-nums">{c.sites.length + c.apps.length}</span>
      </button>
      <button className="mr-1 rounded-full p-1 text-faint opacity-0 transition group-hover:opacity-100 hover:bg-line hover:text-fg focus:opacity-100" onClick={onEdit} title={t("Edit “{name}”", { name: t(c.name) })}>
        <Pencil size={12} />
      </button>
    </span>
  );
}

function ListEditor({ list, state, go }: { list: BlockList; state: State; go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const [draft, setDraft, dirty, discard] = useDraft(list);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = usePref<"items" | "exceptions" | "youtube">("lists-tab", "items");
  const exceptSites = draft.exceptSites ?? [];
  const exceptApps = draft.exceptApps ?? [];
  const appAllow = draft.appMode === "allow";
  const channels = draft.youtubeChannels ?? [];
  // What the list would block without its exceptions (suggestions for the Exceptions tab).
  const beforeExceptions = useMemo(() => listTargets(state, { ...draft, exceptSites: [], exceptApps: [] }), [state, draft]);
  const exceptionGroups = useCallback(
    (q: string): SuggestionGroup[] => [
      {
        label: t("In this list"),
        items: [...beforeExceptions.sites]
          .filter((d) => !exceptSites.includes(d) && (!q || score(q, d) > 0))
          .slice(0, q ? 8 : 6)
          .map((d) => ({
            key: `in-${d}`,
            icon: <CircleMinus size={16} className="text-muted" />,
            title: d,
            subtitle: t("Leave it out of this list"),
            onPick: () => setDraft((x) => ({ ...x, exceptSites: [...(x.exceptSites ?? []), d] })),
          })),
      },
    ],
    [beforeExceptions, exceptSites, setDraft],
  );

  const lockBlock = snap!.status.active.filter((a) => a.listId === list.id && a.locked).sort((a, b) => b.endsAt - a.endsAt)[0];
  const lockedSites = useMemo(() => new Set(lockBlock ? list.sites : []), [lockBlock, list.sites]);
  const lockedApps = useMemo(() => new Set(lockBlock ? list.apps.map((a) => a.exe.toLowerCase()) : []), [lockBlock, list.apps]);
  const total = listTargets(state, draft);
  const covered = useMemo(() => {
    const base = listTargets(state, { ...draft, sites: [], apps: [] });
    return { sites: base.sites, apps: new Set(base.apps.keys()) };
  }, [state, draft]);

  const toggleCategory = useCallback(
    (id: string) => setDraft((d) => ({ ...d, categories: d.categories.includes(id) ? d.categories.filter((c) => c !== id) : [...d.categories, id] })),
    [setDraft],
  );

  const categoryGroups = useCallback(
    (q: string): SuggestionGroup[] => [
      {
        label: t("Include a whole category"),
        items: state.categories
          .filter((c) => !draft.categories.includes(c.id) && (!q || score(q, c.name) > 0 || score(q, t(c.name)) > 0))
          .map((c) => ({
            key: `cat-${c.id}`,
            icon: <span className="text-base">{c.icon}</span>,
            title: t(c.name),
            subtitle: t("{sites} sites · {apps} apps — stays in sync when you edit the category", { sites: c.sites.length, apps: c.apps.length }),
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
      subtitle={
        [
          draft.mode === "allow" ? t("only {n} websites allowed", { n: total.sites.size }) : t("{n} websites blocked", { n: total.sites.size }),
          appAllow ? t("only {n} apps allowed", { n: total.apps.size }) : t("{n} apps blocked", { n: total.apps.size }),
        ].join(" · ")
      }
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
            {draft.mode === "allow" || appAllow
              ? t("Locked until {time}. It can only get stricter until then.", { time: fmtTime(lockBlock.endsAt) })
              : t("Locked until {time}. You can add more, but can't remove anything until then.", { time: fmtTime(lockBlock.endsAt) })}
          </div>
        )
      }
    >
      <section className="mb-7 space-y-2">
        <Segmented<ListMode>
          className="w-full"
          value={draft.mode}
          onChange={(mode) => setDraft({ ...draft, mode })}
          options={[
            { value: "block", label: <><Ban size={14} /> {t("Block these websites")}</> },
            { value: "allow", label: <><CircleCheck size={14} /> {t("Allow only these websites")}</> },
          ]}
        />
        <Segmented<ListMode>
          className="w-full"
          value={draft.appMode ?? "block"}
          onChange={(appMode) => setDraft({ ...draft, appMode })}
          options={[
            { value: "block", label: <><Ban size={14} /> {t("Block these apps")}</> },
            { value: "allow", label: <><CircleCheck size={14} /> {t("Allow only these apps")}</> },
          ]}
        />
        {draft.mode === "allow" && (
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            <Puzzle size={16} className="mt-0.5 shrink-0" />
            <div>
              {t("While this list is active, browsers can only open the websites below; everything else is blocked. This needs the OpenBlocker browser extension, and browsers without it are closed while the allowlist runs.")}{" "}
              <span className="text-cyan-300">
                {snap!.status.extension.length
                  ? t("Extension active in {browsers}.", { browsers: snap!.status.extension.map((b) => b.name).join(", ") })
                  : t("The extension isn't connected yet; see Settings → Browser extension.")}
              </span>
            </div>
          </div>
        )}
        {appAllow && (
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            <AppWindow size={16} className="mt-0.5 shrink-0" />
            <div>
              {t("While this list is active, only the apps below can be used: any other program you bring to the front is closed. Windows itself (desktop, taskbar, Settings, File Explorer) and OpenBlocker always keep working.")}{" "}
              <span className="text-cyan-300">{t("Add your browser if you need websites.")}</span>
            </div>
          </div>
        )}
      </section>

      <Segmented
        className="mb-6 w-full"
        value={tab}
        onChange={setTab}
        options={[
          { value: "items", label: <><Tags size={14} /> {draft.mode === "allow" && appAllow ? t("Allowed") : draft.mode === "allow" || appAllow ? t("Items") : t("Blocked")}</> },
          { value: "exceptions", label: <><CircleMinus size={14} /> {t("Exceptions")}{exceptSites.length + exceptApps.length ? ` · ${exceptSites.length + exceptApps.length}` : ""}</> },
          { value: "youtube", label: <><MonitorPlay size={14} /> {t("YouTube channels")}{channels.length ? ` · ${channels.length}${draft.youtubeSubscriptions ? "+" : ""}` : draft.youtubeSubscriptions ? ` · ${t("subscriptions")}` : ""}</> },
        ]}
      />

      {tab === "exceptions" && (
        <>
          <p className="mb-5 text-sm text-muted">
            {tx(
              "Leave websites and apps out of this list without changing its categories, e.g. all social media except Facebook. Works with community lists too. Add part of a site (like {example}) to keep just that reachable while the rest stays blocked; that part needs the browser extension, and the site is then blocked by the extension only.",
              { example: <span className="text-fg">reddit.com/r/rust</span> },
            )}
          </p>
          {lockBlock && (
            <p className="mb-4 flex items-center gap-2 text-sm text-amber-200">
              <Lock size={14} /> {t("Locked: you can remove exceptions, but not add new ones until it ends.")}
            </p>
          )}
          <ItemsEditor
            siteTitle={t("Websites to leave out")}
            appTitle={t("Apps to leave out")}
            sites={exceptSites}
            apps={exceptApps}
            onSites={(exceptSites) => setDraft({ ...draft, exceptSites })}
            onApps={(exceptApps) => setDraft({ ...draft, exceptApps })}
            extraSiteGroups={exceptionGroups}
          />
          {exceptSites.some(isPathSite) && (
            <p className="-mt-3 flex items-center gap-2 text-xs text-cyan-200">
              <Puzzle size={13} /> {t("Exceptions for parts of a site only work in browsers with the extension.")}
            </p>
          )}
        </>
      )}

      {tab === "youtube" && (
        <ChannelsEditor
          channels={channels}
          locked={!!lockBlock}
          blocksYoutube={[...total.sites].some((d) => d === "youtube.com")}
          onChange={(youtubeChannels) => setDraft({ ...draft, youtubeChannels })}
          subscriptions={!!draft.youtubeSubscriptions}
          // While locked, subscriptions can be turned off (stricter) but not on.
          subscriptionsLocked={!!lockBlock && !list.youtubeSubscriptions}
          onSubscriptions={(youtubeSubscriptions) => setDraft({ ...draft, youtubeSubscriptions })}
          browsers={snap!.status.extension}
        />
      )}

      {tab === "items" && (
      <>
      <section className="mb-7">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Tags size={16} className="text-pink-400" /> {draft.mode === "allow" ? t("Allowed categories") : t("Categories")}
          </h3>
          <button className="text-xs text-muted hover:text-fg" onClick={() => go("categories")}>
            {t("Manage categories →")}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.categories.map((c) => (
            <CategoryPill
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
        siteTitle={draft.mode === "allow" ? t("Allowed websites") : t("Extra websites")}
        appTitle={appAllow ? t("Allowed apps") : t("Extra apps")}
        sites={draft.sites}
        apps={draft.apps}
        onSites={(sites) => setDraft({ ...draft, sites })}
        onApps={(apps) => setDraft({ ...draft, apps })}
        lockedSites={lockedSites}
        lockedApps={lockedApps}
        covered={covered}
        extraSiteGroups={categoryGroups}
      />
      </>
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${list.name}”?`}>
        <p className="text-sm text-muted">{t("This also removes its schedules and running quick blocks. Categories are kept.")}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
            {t("Cancel")}
          </button>
          <button className="btn-danger" onClick={() => run(() => api.deleteList(list.id), "List deleted.").then(() => setConfirmDelete(false))}>
            {t("Delete")}
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
    <Modal open={open} onClose={onClose} title={t("New block list")} width={600}>
      <span className="label">{t("Include categories")}</span>
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {categories.map((c) => (
          <button
            key={c.id}
            className={clsx("flex items-center gap-2 rounded-xl border p-2.5 text-left text-sm", cats.includes(c.id) ? "border-accent bg-accent/10" : "border-line bg-card hover:border-line-strong")}
            onClick={() => toggle(c)}
          >
            <span>{c.icon}</span>
            <span className="truncate">{t(c.name)}</span>
            {cats.includes(c.id) && <Check size={14} className="ml-auto shrink-0 text-accent" />}
          </button>
        ))}
      </div>
      <span className="label">{t("Name")}</span>
      <input className="input mb-5" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Evening distractions")} autoFocus />
      <IconColorPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
      <p className="mt-4 text-xs text-muted">{t("You can add individual websites and apps after creating the list.")}</p>
      <div className="mt-6 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className="btn-primary" disabled={!name.trim()} onClick={() => onCreate({ id: uid(), name: name.trim(), icon, color, sites: [], apps: [], categories: cats, mode: "block", appMode: "block" })}>
          {t("Create list")}
        </button>
      </div>
    </Modal>
  );
}

/** "Only these YouTube channels" for a block list. */
function ChannelsEditor({
  channels,
  locked,
  blocksYoutube,
  onChange,
  subscriptions,
  subscriptionsLocked,
  onSubscriptions,
  browsers,
}: {
  channels: string[];
  locked: boolean;
  blocksYoutube: boolean;
  onChange: (c: string[]) => void;
  subscriptions: boolean;
  subscriptionsLocked: boolean;
  onSubscriptions: (on: boolean) => void;
  browsers: BrowserSeen[];
}) {
  const { toast } = useStore();
  const [input, setInput] = useState("");
  const add = () => {
    const c = normalizeChannel(input);
    if (!c) return toast("That doesn't look like a channel. Paste its link or @handle.", "error");
    if (channels.includes(c)) return toast("Already on the list.");
    onChange([...channels, c]);
    setInput("");
  };
  const link = (c: string) => `https://www.youtube.com/${c.startsWith("UC") ? "channel/" + c : c}`;

  return (
    <section className="mb-2">
      <p className="mb-4 text-sm text-muted">
        {t("While this list is active, YouTube videos only play if they're from one of these channels; everything else shows the block page. Search and the home page stay usable. Leave it empty for no restriction. Needs the browser extension (browsers without it are closed while the restriction runs).")}
      </p>
      {blocksYoutube && (
        <p className="mb-4 text-sm text-amber-200">{t("This list blocks youtube.com completely, so channels here have no effect. Remove YouTube (or add it as an exception) to use them.")}</p>
      )}
      {locked && (channels.length > 0 || subscriptions) && (
        <p className="mb-4 flex items-center gap-2 text-sm text-amber-200">
          <Lock size={14} /> {t("Locked: you can remove channels, but not add any until it ends.")}
        </p>
      )}
      <div className="mb-4 rounded-xl border border-line bg-panel px-4">
        <Toggle
          label={t("Allow the channels I'm subscribed to")}
          hint={t(
            "Read from your YouTube subscriptions in browsers with the extension while you're signed in to YouTube there, and refreshed every 30 minutes. While a locked block runs, channels you subscribe to in the meantime don't count.",
          )}
          checked={subscriptions}
          onChange={(on) => (on && subscriptionsLocked ? undefined : onSubscriptions(on))}
        />
        {subscriptionsLocked && !subscriptions && (
          <p className="-mt-1 mb-3 flex items-center gap-2 text-xs text-amber-200">
            <Lock size={12} /> {t("Locked: this can't be turned on until the block ends.")}
          </p>
        )}
        {subscriptions && <SubscriptionStatus browsers={browsers} />}
      </div>
      <div className="mb-3 flex gap-2">
        <input
          className="input"
          placeholder={t("Paste a channel link or @handle, e.g. https://www.youtube.com/@veritasium")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn-ghost shrink-0" disabled={!input.trim()} onClick={add}>
          <Plus size={15} /> {t("Add")}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {channels.map((c) => (
          <span key={c} className="chip py-1.5 pr-1.5 pl-2.5 text-sm">
            {c}
            <a className="rounded p-0.5 text-faint hover:bg-line hover:text-fg" href={link(c)} target="_blank" rel="noreferrer" aria-label={`Open ${c}`}>
              <ExternalLink size={12} />
            </a>
            <button className="rounded p-0.5 text-faint hover:bg-line hover:text-fg" onClick={() => onChange(channels.filter((x) => x !== c))} aria-label={`Remove ${c}`}>
              <X size={13} />
            </button>
          </span>
        ))}
        {!channels.length && (
          <p className="text-sm text-faint">
            {subscriptions ? t("Only channels you're subscribed to.") : t("No restriction: videos from every channel play.")}
          </p>
        )}
      </div>
      <p className="mt-5 text-xs text-faint">{t("Tip: to block only Shorts and keep normal videos, include the “Short videos” category instead.")}</p>
    </section>
  );
}

/** Which browsers could read the subscriptions (reported by the extension while a block needs them). */
function SubscriptionStatus({ browsers }: { browsers: BrowserSeen[] }) {
  const reporting = browsers.filter((b) => b.youtubeSubscriptions !== undefined && b.youtubeSubscriptions !== null);
  return (
    <div className="-mt-1 mb-3 flex flex-wrap gap-2 text-xs">
      {reporting.length ? (
        reporting.map((b) => (
          <span key={b.exe} className={clsx("chip py-1", b.youtubeSubscriptions! < 0 && "border-amber-500/30 text-amber-200")}>
            <AppIcon name={b.name} exe={b.exe} size={14} />
            {b.youtubeSubscriptions! < 0
              ? t("{browser}: not signed in to YouTube", { browser: b.name })
              : t("{browser}: {n} subscribed channels", { browser: b.name, n: b.youtubeSubscriptions! })}
          </span>
        ))
      ) : (
        <span className="text-muted">{t("Your subscriptions are read the next time you open YouTube while this list is active.")}</span>
      )}
    </div>
  );
}
