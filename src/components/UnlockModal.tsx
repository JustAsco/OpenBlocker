import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

/** Shows `challenge` and a textarea it must be typed into exactly. Paste is disabled. */
export function TypeChallenge({ challenge, answer, onAnswer }: { challenge: string; answer: string; onAnswer: (s: string) => void }) {
  let correct = 0;
  while (correct < answer.length && answer[correct] === challenge[correct]) correct++;
  return (
    <>
      <div className="mb-4 max-h-48 overflow-y-auto rounded-xl border border-line bg-bg p-4 font-mono text-sm leading-relaxed break-all select-none">
        <span className="text-emerald-400">{challenge.slice(0, correct)}</span>
        <span className="text-red-400 underline">{answer.length > correct ? challenge.slice(correct, answer.length) : ""}</span>
        <span className="text-muted">{challenge.slice(Math.max(correct, answer.length))}</span>
      </div>
      <textarea
        className="input h-28 resize-none font-mono"
        value={answer}
        autoFocus
        spellCheck={false}
        onPaste={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        onChange={(e) => onAnswer(e.target.value)}
        placeholder="Start typing…"
      />
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
        <div className="h-full bg-accent transition-all" style={{ width: `${(correct / Math.max(1, challenge.length)) * 100}%` }} />
      </div>
    </>
  );
}

/** Type-the-random-text challenge for text-locked sessions. */
export function UnlockModal({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const { run } = useStore();
  const [challenge, setChallenge] = useState("");
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    setAnswer("");
    if (sessionId) api.unlockChallenge(sessionId).then(setChallenge);
  }, [sessionId]);

  const done = answer === challenge && challenge.length > 0;

  return (
    <Modal open={!!sessionId} onClose={onClose} title="Unlock this block?" width={620}>
      <p className="mb-4 text-sm text-muted">
        Type the text below exactly to stop the block early. Copy &amp; paste is disabled. Is this really worth it?
      </p>
      <TypeChallenge challenge={challenge} answer={answer} onAnswer={setAnswer} />
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-primary" onClick={onClose}>
          Keep blocking
        </button>
        <button
          className="btn-danger"
          disabled={!done}
          onClick={async () => {
            if (await run(() => api.stopSession(sessionId!, answer), "Block stopped.")) onClose();
          }}
        >
          Unlock
        </button>
      </div>
    </Modal>
  );
}
