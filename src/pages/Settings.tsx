import { Copy, Download, FolderOpen, Heart, Puzzle, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { PasswordCard } from "../components/PasswordCard";
import { ResetModal } from "../components/ResetModal";
import { PageHeader, Segmented, Toggle, usePref, useSecretClicks } from "../components/ui";
import { api, isTauri } from "../lib/api";
import { useStore } from "../lib/store";
import type { Settings } from "../lib/types";
import { LANGUAGES, t, tx } from "../lib/i18n";
import { olderVersion } from "../lib/util";

export function SettingsPage() {
  const { snap, run } = useStore();
  const { settings } = snap!.state;
  const status = snap!.status;
  const outdated = (b: { extensionVersion: string }) => !!b.extensionVersion && !!status.extensionLatest && olderVersion(b.extensionVersion, status.extensionLatest);
  const [siteIcons, setSiteIcons] = usePref("site-icons", true);
  const [theme, setTheme] = usePref<"dark" | "light" | "system">("theme", "dark");
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
  const versionClick = useSecretClicks(() => setResetOpen(true));

  return (
    <>
      <PageHeader title={t("Settings")} />
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-2 font-semibold">{t("Blocking")}</h2>
          <div className="divide-y divide-line">
            <Toggle label={t("Block subdomains")} hint={t("Also block www., m. and mobile. versions of every website.")} checked={settings.blockSubdomains} lockedOn={locked} onChange={(blockSubdomains) => save({ blockSubdomains })} />
            <Toggle
              label={t("Hide Shorts and Reels in feeds")}
              hint={t("While Shorts or Reels are blocked (e.g. with the “Short videos” category), also hide their shelves and buttons on YouTube, Instagram and Facebook. Needs the extension.")}
              checked={settings.hideShortVideoFeeds}
              lockedOn={locked}
              onChange={(hideShortVideoFeeds) => save({ hideShortVideoFeeds })}
            />
            <Toggle label={t("Flush DNS cache")} hint={t("Helps new blocks apply sooner. Browsers can keep open connections alive; the extension below fixes that.")} checked={settings.flushDns} onChange={(flushDns) => save({ flushDns })} />
            <Toggle label={t("Block Task Manager while frozen")} checked={settings.freezeBlocksTaskManager} onChange={(freezeBlocksTaskManager) => save({ freezeBlocksTaskManager })} />
            <div className="py-3">
              <div className="mb-2 flex justify-between text-sm">
                <span className="font-medium">{t("Unlock text length")}</span>
                <span className="text-muted tabular-nums">{settings.unlockTextStyle === "reflection" ? t("at least {n} characters", { n: settings.unlockTextLength }) : t("{n} characters", { n: settings.unlockTextLength })}</span>
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
              <Segmented
                className="mt-3 w-full"
                value={settings.unlockTextStyle}
                onChange={(unlockTextStyle) => save({ unlockTextStyle })}
                options={[
                  { value: "random", label: t("Random characters"), title: t("Mindless but tedious") },
                  { value: "reflection", label: t("Reflection"), title: t("Sentences about why you want to stop early") },
                ]}
              />
              <p className="mt-2 text-xs text-muted">
                {t("How much you must type to stop a “Type to unlock” block early. “Reflection” has you type sentences about what you're about to give up instead of random characters: whole sentences are added until the length is reached.")}{" "}
                {locked && t("Can only be made longer while a locked block is running.")}
              </p>
            </div>
          </div>
        </section>

        <PasswordCard />

        <section className="card p-6 lg:row-span-2">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <Puzzle size={18} className="text-accent-2" /> {t("Browser extension")}
          </h2>
          <p className="mb-4 text-sm text-muted">
            {t("Blocks websites instantly, including tabs that are already open, and enables allowlists. Strongly recommended in every browser you use.")}
          </p>
          <div className="mb-5 rounded-xl bg-panel p-3">
            {status.extension.length ? (
              <div className="flex flex-wrap gap-2">
                {status.extension.map((b) => (
                  <span key={b.exe} className="chip border-emerald-500/30 bg-emerald-500/10 py-1 text-sm text-emerald-200">
                    <span className="size-2 rounded-full bg-good" /> {b.name}
                    {b.extensionVersion && <span className="text-xs text-emerald-200/60">v{b.extensionVersion}</span>}
                    {b.incognito === false && <span className="text-xs text-amber-300">{t("· not in private windows")}</span>}
                    {outdated(b) && <span className="text-xs text-amber-300">{t("· outdated")}</span>}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-amber-200">{t("Not connected in any browser yet.")}</p>
            )}
            {status.extension.some(outdated) && (
              <p className="mt-2 text-xs text-amber-200">
                {t("A newer extension ({version}) comes with this version of OpenBlocker. It updates itself when it's loaded from the folder below; otherwise open the browser's extensions page and click the reload button ↻ on OpenBlocker, or load the folder below again.", { version: status.extensionLatest ?? "" })}
              </p>
            )}
            {status.extension.some((b) => b.incognito === false) && (
              <p className="mt-2 text-xs text-amber-200">
                {t("Private/incognito windows aren't blocked in {browsers}. Open the extension's details and turn on “Allow in Incognito” (Firefox: “Run in Private Windows”). While the extension is required, such browsers are closed.", {
                  browsers: status.extension
                    .filter((b) => b.incognito === false)
                    .map((b) => b.name)
                    .join(", "),
                })}
              </p>
            )}
            {status.bridgeError && <p className="mt-2 text-xs text-red-300">{status.bridgeError}</p>}
          </div>

          <h3 className="mb-2 text-sm font-medium">{t("Install in Chrome, Edge, Brave, Opera or Vivaldi")}</h3>
          <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-muted">
            <li>
              {tx("Open {chrome} (Edge: {edge}).", { chrome: <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">chrome://extensions</code>, edge: <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">edge://extensions</code> })}
            </li>
            <li>{tx("Turn on {mode}.", { mode: <span className="text-fg">{t("Developer mode")}</span> })}</li>
            <li>
              {tx("Click {button} and choose this folder:", { button: <span className="text-fg">{t("Load unpacked")}</span> })}
            </li>
          </ol>
          <div className="mb-5 flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-panel px-3 py-2 text-xs leading-5 text-fg select-all" title={extPath ?? ""}>
              {extPath ?? t("Extension folder not found")}
            </code>
            <button
              className="btn-ghost px-3"
              disabled={!extPath}
              title={t("Copy path")}
              onClick={() => navigator.clipboard.writeText(extPath!).then(() => toast("Path copied.", "success"))}
            >
              <Copy size={15} />
            </button>
            {isTauri && (
              <button className="btn-ghost px-3" disabled={!extPath} title={t("Open folder")} onClick={() => api.openExtensionFolder().catch((e) => toast(String(e), "error"))}>
                <FolderOpen size={15} />
              </button>
            )}
          </div>
          <h3 className="mb-2 text-sm font-medium">{t("Firefox")}</h3>
          <p className="mb-4 text-sm text-muted">
            {tx("Open {page} → This Firefox → Load Temporary Add-on → pick {file} in the folder above. Firefox removes it on restart until the add-on is published.", {
              page: <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">about:debugging</code>,
              file: <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">manifest.json</code>,
            })}
          </p>
          <div className="border-t border-line">
            <Toggle
              label={t("Close browsers without the extension")}
              hint={t("While websites are blocked, browsers in which the extension isn't running are closed after 30 seconds. Always on while an allowlist is active.")}
              checked={settings.requireExtension}
              lockedOn={locked}
              onChange={(requireExtension) => save({ requireExtension })}
            />
            <Toggle
              label={t("Suggest the extension")}
              hint={t("When websites get blocked and no browser has the extension, ask whether you'd like to set it up. Blocking through the hosts file works either way.")}
              checked={settings.suggestExtension}
              onChange={(suggestExtension) => save({ suggestExtension })}
            />
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-2 font-semibold">{t("App")}</h2>
          <div className="divide-y divide-line">
            {autostart !== null && (status.platform === "windows" || !isTauri) && (
              <Toggle
                label={t("Start with Windows")}
                hint={
                  status.service
                    ? t("Opens OpenBlocker in the tray when you log in. Blocking itself runs in the background service either way.")
                    : t("Opens OpenBlocker in the tray when you log in, so blocks apply from the start.")
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
            <Toggle label={t("Notifications")} hint={t("Pomodoro phases, finished blocks and closed apps.")} checked={settings.notifications} onChange={(notifications) => save({ notifications })} />
            <Toggle label={t("Keep running in the tray")} hint={t("Closing the window keeps your blocks active.")} checked={settings.closeToTray} onChange={(closeToTray) => save({ closeToTray })} />
            <Toggle label={t("Show website icons")} hint={t("Icons are loaded from Google's favicon service.")} checked={siteIcons} onChange={setSiteIcons} />
            <div className="flex items-center justify-between gap-6 py-3">
              <span className="text-sm font-medium">{t("Theme")}</span>
              <Segmented
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "dark", label: t("Dark") },
                  { value: "light", label: t("Light") },
                  { value: "system", label: t("System") },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-6 py-3">
              <span className="text-sm font-medium">{t("Language")}</span>
              <select className="input w-auto py-1.5" value={settings.language} onChange={(e) => save({ language: e.target.value })}>
                <option value="">{t("Like Windows")}</option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">{t("System status")}</h2>
          <div className="flex items-start gap-3">
            {status.service || status.elevated ? <ShieldCheck className="shrink-0 text-good" /> : <ShieldAlert className="shrink-0 text-warn" />}
            <div className="text-sm">
              <div className="font-medium">
                {status.service ? t("Protected by the background service") : status.elevated ? t("Running with administrator rights") : t("Limited mode")}
              </div>
              <p className="mt-0.5 text-muted">
                {status.service
                  ? t("Blocking runs in the OpenBlocker service, even while this window is closed. Closing or killing the app doesn't end a block, and locks can't be undone by editing files.")
                  : status.elevated
                    ? t("Website and app blocking work while OpenBlocker is open. Install it with the installer to get the background service, so blocks keep running when the app is closed.")
                    : t("The background service isn't running, and website blocking needs it (or administrator rights). App blocking still works.")}
              </p>
              {!status.service && !status.elevated && isTauri && (
                <button className="btn-ghost mt-3" onClick={() => run(async () => (await api.relaunchAsAdmin(), api.snapshot()))}>
                  {t("Restart as administrator")}
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-1 font-semibold">{t("Backup")}</h2>
          <p className="mb-4 text-sm text-muted">
            {t("Save your block lists, categories, schedules and settings to a file, to keep a backup or move them to another computer. Running blocks and statistics aren't included.")}
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
              <Download size={15} /> {t("Export…")}
            </button>
            <button
              className="btn-ghost"
              disabled={locked}
              title={locked ? t("Not available while a locked block is running") : t("Replaces your lists, categories, schedules and settings")}
              onClick={() => run(api.importSettings, "Settings imported.")}
            >
              <Upload size={15} /> {t("Import…")}
            </button>
          </div>
          {locked && <p className="mt-2 text-xs text-faint">{t("Importing is disabled while a locked block is running.")}</p>}
        </section>

        <section className="card p-6">
          <h2 className="mb-2 font-semibold">{t("About")}</h2>
          <p className="text-sm text-muted">
            <span onClick={versionClick} className="cursor-default select-none">
              OpenBlocker 0.1.0
            </span>{" "}
            {t("· free & open source under the AGPL-3.0. Your data never leaves your computer.")}
          </p>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            <Heart size={16} className="text-pink-400" /> {t("Contributions welcome!")}
          </p>
          <p className="mt-3 text-xs text-faint">{t("Platform: {name}", { name: status.platform })}</p>
        </section>
      </div>
      <ResetModal open={resetOpen} onClose={() => setResetOpen(false)} />
    </>
  );
}
