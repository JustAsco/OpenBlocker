import { LifeBuoy, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { TypeChallenge } from "./UnlockModal";
import { HoldButton, Modal } from "./ui";
import { t, tx } from "../lib/i18n";

/**
 * Emergency reset, reached by clicking the version number in Settings → About
 * seven times. It's the way out of a lock you can't live with (e.g. a 24/7
 * locked schedule) without reinstalling. While something is locked, a long
 * random text has to be typed first, so it's never a quick escape.
 */
export function ResetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { run } = useStore();
  const [challenge, setChallenge] = useState<string | null | undefined>(undefined);
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    setAnswer("");
    setChallenge(undefined);
    if (open) api.resetChallenge().then(setChallenge).catch(() => setChallenge(null));
  }, [open]);

  const ready = challenge === null || (!!challenge && answer === challenge);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title={
        <span className="flex items-center gap-2">
          <LifeBuoy size={18} className="text-red-400" /> {t("Emergency reset")}
        </span>
      }
    >
      <p className="mb-3 text-sm">{t("This puts OpenBlocker back to how it was when you installed it:")}</p>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-muted">
        <li>{t("every block list, schedule and change to categories is deleted,")}</li>
        <li>{t("running blocks, the focus timer and locks end immediately,")}</li>
        <li>{t("all settings go back to their defaults.")}</li>
      </ul>
      <p className="mb-4 text-sm text-muted">
        {tx("Your statistics are kept, and a copy of your current data is saved as {file} in OpenBlocker's data folder. If you just want to move your setup elsewhere, use {export} instead.", {
          file: <code className="rounded bg-elevated px-1.5 py-0.5 text-fg">state.before-reset.json</code>,
          export: <span className="text-fg">{t("Export")}</span>,
        })}
      </p>
      {challenge && (
        <>
          <p className="mb-3 text-sm text-amber-200">{t("Something is locked right now. To reset anyway, type this text exactly (paste is disabled):")}</p>
          <TypeChallenge challenge={challenge} answer={answer} onAnswer={setAnswer} />
        </>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-primary" onClick={onClose}>
          {t("Cancel")}
        </button>
        {ready ? (
          <HoldButton className="btn-danger" ms={3000} onConfirm={() => run(() => api.factoryReset(answer || undefined), "OpenBlocker was reset.").then((ok) => ok && onClose())}>
            <RotateCcw size={15} /> {t("Hold to reset everything")}
          </HoldButton>
        ) : (
          <button className="btn-danger" disabled>
            <RotateCcw size={15} /> {t("Reset everything")}
          </button>
        )}
      </div>
    </Modal>
  );
}
