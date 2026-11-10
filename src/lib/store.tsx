import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, onSnapshot } from "./api";
import type { Snapshot } from "./types";

interface Toast {
  id: number;
  kind: "error" | "success" | "info";
  text: string;
}

interface Ctx {
  snap: Snapshot | null;
  /** Run a command that returns a fresh snapshot; errors become toasts. Returns true on success. */
  run: (fn: () => Promise<Snapshot>, success?: string) => Promise<boolean>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  toasts: Toast[];
  /** Ticks every second so countdowns re-render smoothly. */
  now: number;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(Date.now());
  const nextId = useRef(1);

  useEffect(() => {
    api.snapshot().then(setSnap).catch(console.error);
    const off = onSnapshot(setSnap);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);

  const run = useCallback(
    async (fn: () => Promise<Snapshot>, success?: string) => {
      try {
        setSnap(await fn());
        if (success) toast(success, "success");
        return true;
      } catch (e) {
        toast(String(e), "error");
        return false;
      }
    },
    [toast],
  );

  return <StoreCtx.Provider value={{ snap, run, toast, toasts, now }}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}
