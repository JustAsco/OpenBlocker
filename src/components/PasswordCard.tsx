import { KeyRound } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

type Mode = "set" | "change" | "remove";

/**
 * The account-wide unlock password for "Password" blocks. Ideally someone
 * you trust types it in, so only they can end such a block early.
 */
export function PasswordCard() {
  const { snap, run } = useStore();
  const isSet = snap!.status.passwordSet;
  const [mode, setMode] = useState<Mode | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");

  const open = (m: Mode) => {
    setCurrent("");
    setNext("");
    setRepeat("");
    setMode(m);
  };
  const needsNew = mode === "set" || mode === "change";
  const valid = (!isSet || current.length > 0) && (!needsNew || (next.length >= 4 && next === repeat));
  const submit = async () => {
    const ok = await run(
      () => api.setPassword(isSet ? current : null, needsNew ? next : null),
      mode === "remove" ? "Password removed." : "Password saved.",
    );
    if (ok) setMode(null);
    else setCurrent("");
  };

  return (
    <section className="card p-6">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <KeyRound size={18} className="text-accent-2" /> Unlock password
      </h2>
      <p className="mb-4 text-sm text-muted">
        Adds a “Password” strictness to quick blocks: only this password can stop them early. Works best if someone you trust sets it, so they can unlock for you
        when you ask.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className={isSet ? "chip border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "chip text-muted"}>{isSet ? "Password is set" : "No password set"}</span>
        <div className="flex-1" />
        {isSet ? (
          <>
            <button className="btn-ghost" onClick={() => open("change")}>
              Change
            </button>
            <button className="btn-ghost" onClick={() => open("remove")}>
              Remove
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={() => open("set")}>
            Set a password
          </button>
        )}
      </div>

      <Modal open={mode !== null} onClose={() => setMode(null)} title={mode === "set" ? "Set an unlock password" : mode === "change" ? "Change the password" : "Remove the password"} width={460}>
        {mode === "set" && (
          <p className="mb-4 text-sm text-muted">
            Hand the keyboard to whoever should keep it. Changing or removing it later needs this password. If it's lost, the emergency reset is the only way out.
          </p>
        )}
        <div className="space-y-3">
          {isSet && (
            <input className="input" type="password" autoFocus autoComplete="off" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          )}
          {needsNew && (
            <>
              <input
                className="input"
                type="password"
                autoFocus={!isSet}
                autoComplete="new-password"
                placeholder="New password (at least 4 characters)"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="Repeat the new password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && valid && submit()}
              />
              {repeat && next !== repeat && <p className="text-xs text-red-300">The passwords don't match.</p>}
            </>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setMode(null)}>
            Cancel
          </button>
          <button className={mode === "remove" ? "btn-danger" : "btn-primary"} disabled={!valid} onClick={submit}>
            {mode === "remove" ? "Remove" : "Save"}
          </button>
        </div>
      </Modal>
    </section>
  );
}
