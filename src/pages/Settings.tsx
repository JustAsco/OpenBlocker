import { Heart, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
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
  useEffect(() => {
    api.getAutostart().then(setAutostart).catch(() => setAutostart(false));
  }, []);
  const save = (patch: Partial<Settings>) => run(() => api.saveSettings({ ...settings, ...patch }));

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-2 font-semibold">Blocking</h2>
          <div className="divide-y divide-line">
            <Toggle label="Block subdomains" hint="Also block www., m. and mobile. versions of every website." checked={settings.blockSubdomains} onChange={(blockSubdomains) => save({ blockSubdomains })} />
            <Toggle label="Flush DNS cache" hint="Makes website blocks apply immediately. Already-open tabs may need a refresh." checked={settings.flushDns} onChange={(flushDns) => save({ flushDns })} />
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
                onChange={(e) => save({ unlockTextLength: Number(e.target.value) })}
                className="w-full accent-violet-500"
              />
              <p className="mt-1 text-xs text-muted">How much you must type to stop a “Type to unlock” block early.</p>
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-2 font-semibold">App</h2>
          <div className="divide-y divide-line">
            {autostart !== null && (status.platform === "windows" || !isTauri) && (
              <Toggle
                label="Start with Windows"
                hint="Starts minimized at login with administrator rights, so blocks apply from boot."
                checked={autostart}
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
            {status.elevated ? <ShieldCheck className="shrink-0 text-good" /> : <ShieldAlert className="shrink-0 text-warn" />}
            <div className="text-sm">
              <div className="font-medium">{status.elevated ? "Running with administrator rights" : "Limited mode"}</div>
              <p className="mt-0.5 text-muted">
                {status.elevated
                  ? "Website and app blocking are fully enabled."
                  : "Website blocking edits the system hosts file, which needs administrator rights. App blocking still works."}
              </p>
              {!status.elevated && isTauri && (
                <button className="btn-ghost mt-3" onClick={() => run(async () => (await api.relaunchAsAdmin(), api.snapshot()))}>
                  Restart as administrator
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-2 font-semibold">About</h2>
          <p className="text-sm text-muted">
            OpenBlocker 0.1.0 · free &amp; open source under the AGPL-3.0. Your data never leaves your computer.
          </p>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            <Heart size={16} className="text-pink-400" /> Contributions welcome!
          </p>
          <p className="mt-3 text-xs text-faint">Platform: {status.platform}</p>
        </section>
      </div>
    </>
  );
}
