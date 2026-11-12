import { Copy, Download, FolderOpen, Heart, Puzzle, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ResetModal } from "../components/ResetModal";
import { PageHeader, Toggle, usePref } from "../components/ui";
import { api, isTauri } from "../lib/api";
import { useStore } from "../lib/store";
import type { Settings } from "../lib/types";

export function SettingsPage() {
  const { snap, run } = useStore();
  const { settings } = snap!.state;
  const status = snap!.status;
  const [siteIcons, setSiteIcons] = usePref("site-icons", true);
  const { toast } = useStore();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [extPath, setExtPath] = useState<string | null>(null);
  useEffect(() => {
    api.extensionPath().then(setExtPath).catch(() => {});
  }, []);
  useEffect(() => {
    api.getAutostart().then(setAutostart).catch(() => setAutostart(false));
  }, []);
  const save = (patch: Partial<Settings>) => run(() => api.saveSettings({ ...settings, ...patch }));
  const locked = status.active.some((b) => b.locked);
  // Hidden emergency reset: click the version number 7 times in a row.
  const [resetOpen, setResetOpen] = useState(false);
  const clicks = useRef<number[]>([]);
  const versionClick = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 3000), now];
    if (clicks.current.length >= 7) {
      clicks.current = [];
      setResetOpen(true);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-2 font-semibold">Blocking</h2>
          <div className="divide-y divide-line">
            <Toggle label="Block subdomains" hint="Also block www., m. and mobile. versions of every website." checked={settings.blockSubdomains} lockedOn={locked} onChange={(blockSubdomains) => save({ blockSubdomains })} />
            <Toggle
              label="Hide Shorts and Reels in feeds"
              hint="While Shorts or Reels are blocked (e.g. with the “Short videos” category), also hide their shelves and buttons on YouTube, Instagram and Facebook. Needs the extension."
              checked={settings.hideShortVideoFeeds}
              lockedOn={locked}
              onChange={(hideShortVideoFeeds) => save({ hideShortVideoFeeds })}
            />
            <Toggle label="Flush DNS cache" hint="Helps new blocks apply sooner. Browsers can keep open connections alive; the extension below fixes that." checked={settings.flushDns} onChange={(flushDns) => save({ flushDns })} />
            <Toggle label="Block Task Manager while frozen" checked={settings.freezeBlocksTaskManager} onChange={(freezeBlocksTaskManager) => save({ freezeBlocksTaskManager })} />
            <div className="py-3">
              <div className="mb-2 flex justify-between text-sm">
                <span className="font-medium">Unlock text length</span>
                <span className="text-muted tabular-nums">{settings.unlockTextLength} characters</span>
              </div>
              <input
                type="range"
                min={20}
                max={500}
                step={10}
                value={settings.unlockTextLength}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  // While locked, the text may get longer but not shorter.
                  if (!locked || v >= settings.unlockTextLength) save({ unlockTextLength: v });
                }}
                className="w-full accent-violet-500"
              />
              <p className="mt-1 text-xs text-muted">
                How much you must type to stop a “Type to unlock” block early.{locked && " Can only be made longer while a locked block is running."}
              </p>
            </div>
          </div>
        </section>

        <section className="card p-6 lg:row-span-2">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <Puzzle size={18} className="text-accent-2" /> Browser extension
          </h2>
          <p className="mb-4 text-sm text-muted">
            Blocks websites instantly, including tabs that are already open, and enables allowlists. Strongly recommended in every browser you use.
          </p>
          <div className="mb-5 rounded-xl bg-panel p-3">
            {status.extension.length ? (
              <div className="flex flex-wrap gap-2">
                {status.extension.map((b) => (
                  <span key={b.exe} className="chip border-emerald-500/30 bg-emerald-500/10 py-1 text-sm text-emerald-200">
                    <span className="size-2 rounded-full bg-good" /> {b.name}
                    {b.extensionVersion && <span className="text-xs text-emerald-200/60">v{b.extensionVersion}</span>}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-amber-200">Not connected in any browser yet.</p>
            )}
            {status.bridgeError && <p className="mt-2 text-xs text-red-300">{status.bridgeError}</p>}
          </div>

          <h3 className="mb-2 text-sm font-medium">Install in Chrome, Edge, Brave, Opera or Vivaldi</h3>
          <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-muted">
            <li>
              Open <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">chrome://extensions</code> (Edge: <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">edge://extensions</code>).
            </li>
            <li>Turn on <span className="text-fg">Developer mode</span>.</li>
            <li>
              Click <span className="text-fg">Load unpacked</span> and choose this folder:
            </li>
          </ol>
          <div className="mb-5 flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-panel px-3 py-2 text-xs leading-5 text-fg select-all" title={extPath ?? ""}>
              {extPath ?? "Extension folder not found"}
            </code>
            <button
              className="btn-ghost px-3"
              disabled={!extPath}
              title="Copy path"
              onClick={() => navigator.clipboard.writeText(extPath!).then(() => toast("Path copied.", "success"))}
            >
              <Copy size={15} />
            </button>
            {isTauri && (
              <button className="btn-ghost px-3" disabled={!extPath} title="Open folder" onClick={() => api.openExtensionFolder().catch((e) => toast(String(e), "error"))}>
                <FolderOpen size={15} />
              </button>
            )}
          </div>
          <h3 className="mb-2 text-sm font-medium">Firefox</h3>
          <p className="mb-4 text-sm text-muted">
            Open <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">about:debugging</code> → This Firefox → Load Temporary Add-on → pick{" "}
            <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">manifest.json</code> in the folder above. Firefox removes it on restart until the add-on is
            published.
          </p>
          <div className="border-t border-line">
            <Toggle
              label="Close browsers without the extension"
              hint="While websites are blocked, browsers in which the extension isn't running are closed after 30 seconds. Always on while an allowlist is active."
              checked={settings.requireExtension}
              lockedOn={locked}
              onChange={(requireExtension) => save({ requireExtension })}
            />
            <Toggle
              label="Suggest the extension"
              hint="When websites get blocked and no browser has the extension, ask whether you'd like to set it up. Blocking through the hosts file works either way."
              checked={settings.suggestExtension}
              onChange={(suggestExtension) => save({ suggestExtension })}
            />
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-2 font-semibold">App</h2>
          <div className="divide-y divide-line">
            {autostart !== null && (status.platform === "windows" || !isTauri) && (
              <Toggle
                label="Start with Windows"
                hint={
                  status.service
                    ? "Opens OpenBlocker in the tray when you log in. Blocking itself runs in the background service either way."
                    : "Opens OpenBlocker in the tray when you log in, so blocks apply from the start."
                }
                checked={autostart}
                lockedOn={locked}
                onChange={(v) =>
                  api
                    .setAutostart(v)
                    .then((now) => {
                      setAutostart(now);
                      toast(now ? "OpenBlocker will start with Windows." : "Autostart disabled.", "success");
                    })
                    .catch((e) => toast(String(e), "error"))
                }
              />
            )}
            <Toggle label="Notifications" hint="Pomodoro phases, finished blocks and closed apps." checked={settings.notifications} onChange={(notifications) => save({ notifications })} />
            <Toggle label="Keep running in the tray" hint="Closing the window keeps your blocks active." checked={settings.closeToTray} onChange={(closeToTray) => save({ closeToTray })} />
            <Toggle label="Show website icons" hint="Icons are loaded from Google's favicon service." checked={siteIcons} onChange={setSiteIcons} />
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">System status</h2>
          <div className="flex items-start gap-3">
            {status.service || status.elevated ? <ShieldCheck className="shrink-0 text-good" /> : <ShieldAlert className="shrink-0 text-warn" />}
            <div className="text-sm">
              <div className="font-medium">
                {status.service ? "Protected by the background service" : status.elevated ? "Running with administrator rights" : "Limited mode"}
              </div>
              <p className="mt-0.5 text-muted">
                {status.service
                  ? "Blocking runs in the OpenBlocker service, even while this window is closed. Closing or killing the app doesn't end a block, and locks can't be undone by editing files."
                  : status.elevated
                    ? "Website and app blocking work while OpenBlocker is open. Install it with the installer to get the background service, so blocks keep running when the app is closed."
                    : "The background service isn't running, and website blocking needs it (or administrator rights). App blocking still works."}
              </p>
              {!status.service && !status.elevated && isTauri && (
                <button className="btn-ghost mt-3" onClick={() => run(async () => (await api.relaunchAsAdmin(), api.snapshot()))}>
                  Restart as administrator
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-1 font-semibold">Backup</h2>
          <p className="mb-4 text-sm text-muted">
            Save your block lists, categories, schedules and settings to a file, to keep a backup or move them to another computer. Running blocks and statistics
            aren't included.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-ghost"
              onClick={() =>
                api
                  .exportSettings()
                  .then((saved) => saved && toast("Settings exported.", "success"))
                  .catch((e) => toast(String(e), "error"))
              }
            >
              <Download size={15} /> Export…
            </button>
            <button
              className="btn-ghost"
              disabled={locked}
              title={locked ? "Not available while a locked block is running" : "Replaces your lists, categories, schedules and settings"}
              onClick={() => run(api.importSettings, "Settings imported.")}
            >
              <Upload size={15} /> Import…
            </button>
          </div>
          {locked && <p className="mt-2 text-xs text-faint">Importing is disabled while a locked block is running.</p>}
        </section>

        <section className="card p-6">
          <h2 className="mb-2 font-semibold">About</h2>
          <p className="text-sm text-muted">
            <span onClick={versionClick} className="cursor-default select-none">
              OpenBlocker 0.1.0
            </span>{" "}
            · free &amp; open source under the AGPL-3.0. Your data never leaves your computer.
          </p>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            <Heart size={16} className="text-pink-400" /> Contributions welcome!
          </p>
          <p className="mt-3 text-xs text-faint">Platform: {status.platform}</p>
        </section>
      </div>
      <ResetModal open={resetOpen} onClose={() => setResetOpen(false)} />
    </>
  );
}
