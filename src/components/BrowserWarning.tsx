import { Puzzle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, onBrowserWarning, type BrowserNotice } from "../lib/api";
import { t } from "../lib/i18n";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

const WARNING_MS = 60_000;

/**
 * "Chrome will be closed in a minute": shown when the backend warns about a
 * browser. For private windows in the "Default" setting it offers to stop
 * including them instead (not while a locked block runs: that would loosen it).
 */
export function BrowserWarning() {
  const { snap, run, now } = useStore();
  const [notice, setNotice] = useState<(BrowserNotice & { at: number }) | null>(null);
  useEffect(() => onBrowserWarning((n) => setNotice({ ...n, at: Date.now() })), []);
  if (!notice || !snap) return null;

  const settings = snap.state.settings;
  const locked = snap.status.active.some((b) => b.locked);
  const left = Math.min(60, Math.max(0, Math.ceil((notice.at + WARNING_MS - now) / 1000)));
  const optOut = notice.reason === "privateWindows" && settings.privateWindows === "default" && !locked;
  const close = () => setNotice(null);

  return (
    <Modal
      open
      onClose={close}
      width={500}
      title={
        <span className="flex items-center gap-2">
          <Puzzle size={18} className="text-amber-400" /> {t("{browser} will be closed in {n} s", { browser: notice.browser, n: left })}
        </span>
      }
    >
      <p className="mb-4 text-sm text-muted">
        {notice.reason === "privateWindows"
          ? t("The OpenBlocker extension isn't allowed in private windows, so they'd get around this block. Turn on “Allow in Incognito” in the extension's details (a page in the browser shows how).")
          : notice.reason === "deactivated"
            ? t("The OpenBlocker extension was turned off in this browser during a block. Turn it back on to keep the browser open.")
            : t("The OpenBlocker extension isn't running in this browser, and “Close browsers without the extension” is on.")}
      </p>
      <div className="flex justify-end gap-2">
        {optOut && (
          <button
            className="btn-ghost"
            onClick={async () => {
              if (await run(() => api.saveSettings({ ...settings, privateWindows: "off" }), "Private windows aren't included any more.")) close();
            }}
          >
            {t("Don't include private windows")}
          </button>
        )}
        <button className="btn-primary" onClick={close}>
          {t("OK")}
        </button>
      </div>
    </Modal>
  );
}
