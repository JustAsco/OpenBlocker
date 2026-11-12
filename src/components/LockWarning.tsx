import { Lock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { HoldButton, Modal } from "./ui";
import { language, t } from "../lib/i18n";

/** The highlighted word "locked", for the sentence passed to LockWarning. */
export const lockedWord = () => <span className="font-medium text-amber-300">{t("locked")}</span>;

/** Full date and time, unambiguous even weeks ahead. */
export function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString(language(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Last chance before something locked starts: locked blocks can't be stopped,
 * shortened or edited, and OpenBlocker refuses to quit while they run.
 * Confirming requires holding the button, so it can't be clicked through.
 */
export function LockWarning({
  open,
  summary,
  escape,
  severe,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** What gets locked until when, e.g. "Blocking Games for 2 h is locked until Tue 17:30." (use lockedWord()). */
  summary: ReactNode;
  /** The unlock password can end it early. */
  escape?: boolean;
  /** Extra, more alarming note (very long or never-ending locks). */
  severe?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={<span className="flex items-center gap-2"><Lock size={18} className="text-amber-400" /> {escape ? t("Only the password can undo this") : t("This can't be undone")}</span>} width={520}>
      <p className="mb-3 text-sm">
        {summary}
      </p>
      <ul className="mb-4 list-disc space-y-1.5 pl-5 text-sm text-muted">
        <li>{escape ? t("Only the unlock password can stop it early.") : t("There is no way to stop, pause or shorten it early.")}</li>
        <li>{t("The block lists it uses can only get longer: nothing can be removed or deleted.")}</li>
        <li>{t("OpenBlocker won't quit while it runs, and restarting your computer doesn't end it.")}</li>
      </ul>
      {severe && (
        <div className="mb-4 flex gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" />
          <div>{severe}</div>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          {t("Go back")}
        </button>
        <HoldButton className="btn-danger" onConfirm={onConfirm}>
          <Lock size={15} /> {t("Hold to lock it")}
        </HoldButton>
      </div>
    </Modal>
  );
}
