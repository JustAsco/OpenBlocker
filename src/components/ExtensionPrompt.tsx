import { Puzzle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Page } from "../App";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

/** Give a browser that's already running the extension time to check in. */
const GRACE_MS = 6000;

/**
 * Suggests the browser extension when website blocking starts and no browser
 * has it. Purely optional: the hosts file keeps blocking either way, the
 * extension just makes it instant (open tabs included). Can be turned off
 * here or in Settings.
 */
export function ExtensionPrompt({ go }: { go: (p: Page) => void }) {
  const { snap, run } = useStore();
  const { status, state } = snap!;
  const blockingSites = status.blockedSites > 0 || status.allowlistSites !== null;
  const wanted = blockingSites && status.extension.length === 0 && state.settings.suggestExtension;
  const [open, setOpen] = useState(false);
  const [never, setNever] = useState(false);
  const wasBlocking = useRef(false);
  const latest = useRef(wanted);
  latest.current = wanted;

  // When website blocking starts (or is already running when the app opens)…
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (blockingSites && !wasBlocking.current) setStartedAt(Date.now());
    if (!blockingSites) setStartedAt(null);
    wasBlocking.current = blockingSites;
  }, [blockingSites]);
  // …ask after a grace period, if the extension still hasn't shown up.
  useEffect(() => {
    if (startedAt === null) return;
    const t = setTimeout(() => {
      setStartedAt(null);
      if (latest.current) setOpen(true);
    }, GRACE_MS);
    return () => clearTimeout(t);
  }, [startedAt]);

  // Close by itself if the extension connects while the prompt is open.
  useEffect(() => {
    if (open && !wanted) setOpen(false);
  }, [open, wanted]);

  const close = () => {
    setOpen(false);
    if (never) run(() => api.saveSettings({ ...state.settings, suggestExtension: false }));
  };
  const hostsWorking = (status.service || status.elevated) && !status.hostsError;

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <Puzzle size={18} className="text-accent-2" /> Add the browser extension?
        </span>
      }
      width={500}
    >
      {hostsWorking ? (
        <p className="mb-3 text-sm text-muted">
          Websites are now blocked in every browser through your system's hosts file. Tabs that are already open can keep working for a few minutes, though,
          and parts of websites (like <span className="text-fg">youtube.com/shorts</span>) can't be blocked that way.
        </p>
      ) : (
        <p className="mb-3 text-sm text-amber-200">
          OpenBlocker can't edit the hosts file right now (the background service isn't running and the app has no administrator rights). Without the
          extension, websites aren't blocked.
        </p>
      )}
      <p className="mb-5 text-sm text-muted">
        The extension blocks instantly, including open tabs, and shows a friendly page instead. Both work together, so you can add it any time.
      </p>
      <label className="mb-5 flex cursor-pointer items-center gap-2 text-sm text-muted">
        <input type="checkbox" className="accent-violet-500" checked={never} onChange={(e) => setNever(e.target.checked)} />
        Don't suggest this again
      </label>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={close}>
          Not now
        </button>
        <button
          className="btn-primary"
          onClick={() => {
            close();
            go("settings");
          }}
        >
          <Puzzle size={15} /> Set it up
        </button>
      </div>
    </Modal>
  );
}
