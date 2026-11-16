import type { Session } from "@supabase/supabase-js";
import { CloudDownload, CloudUpload, LogOut, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { cloudEnabled, download, onSession, signIn, signOut, signUp, upload } from "../lib/cloud";
import { language, t } from "../lib/i18n";
import { useStore } from "../lib/store";

const fmtDate = (ts: number) => new Date(ts).toLocaleString(language(), { dateStyle: "medium", timeStyle: "short" });

/**
 * Optional account for syncing lists, categories, schedules, limits and
 * settings between computers. Hidden in builds without a sync server.
 */
export function AccountCard() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => onSession(setSession), []);
  if (!cloudEnabled) return null;

  return (
    <section className="card self-start p-6">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <UserRound size={18} className="text-accent-2" /> {t("Account & sync")}
      </h2>
      {session === undefined ? null : session ? <SignedIn email={session.user.email ?? ""} /> : <SignIn />}
    </section>
  );
}

function SignIn() {
  const { toast } = useStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && password.length >= (creating ? 8 : 1);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (!creating) await signIn(email.trim(), password);
      else if (!(await signUp(email.trim(), password))) toast(t("Account created. Open the link in the email we sent, then sign in."), "info");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        {t("Optional. Sign in to keep your block lists, categories, schedules, limits and settings in sync between computers. Without an account everything works the same, and nothing leaves this computer.")}
      </p>
      <div className="space-y-2">
        <input className="input" type="email" autoComplete="email" placeholder={t("Email address")} value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          className="input"
          type="password"
          autoComplete={creating ? "new-password" : "current-password"}
          placeholder={creating ? t("Password (at least 8 characters)") : t("Password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="text-xs text-muted hover:underline" onClick={() => setCreating(!creating)}>
          {creating ? t("I already have an account") : t("Create an account")}
        </button>
        <div className="flex-1" />
        <button className="btn-primary" disabled={!valid || busy} onClick={submit}>
          {creating ? t("Create account") : t("Sign in")}
        </button>
      </div>
    </>
  );
}

function SignedIn({ email }: { email: string }) {
  const { snap, run, toast } = useStore();
  const locked = snap!.status.active.some((b) => b.locked);
  // undefined = still checking, null = nothing uploaded yet.
  const [cloudAt, setCloudAt] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    download()
      .then((c) => setCloudAt(c?.updatedAt ?? null))
      .catch((e) => (setCloudAt(null), toast(String(e), "error")));
  }, [toast]);

  const doUpload = async () => {
    setBusy(true);
    try {
      setCloudAt(await upload(await api.getBackup()));
      toast(t("Uploaded to your account."), "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const doDownload = async () => {
    setBusy(true);
    await run(async () => {
      const copy = await download();
      if (!copy) throw t("There's nothing in your account yet.");
      return api.restoreBackup(copy.data);
    }, t("Settings downloaded from your account."));
    setBusy(false);
  };

  return (
    <>
      <p className="mb-1 text-sm">{t("Signed in as {email}", { email })}</p>
      <p className="mb-4 text-xs text-muted">
        {cloudAt === undefined ? "…" : cloudAt === null ? t("Nothing uploaded yet.") : t("Last uploaded: {date}", { date: fmtDate(cloudAt) })}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" disabled={busy} title={t("Replaces the copy in your account with this computer's settings")} onClick={doUpload}>
          <CloudUpload size={15} /> {t("Upload")}
        </button>
        <button
          className="btn-ghost"
          disabled={busy || locked || !cloudAt}
          title={locked ? t("Not available while a locked block is running") : t("Replaces this computer's lists, categories, schedules, limits and settings")}
          onClick={doDownload}
        >
          <CloudDownload size={15} /> {t("Download")}
        </button>
        <div className="flex-1" />
        <button className="btn-ghost" disabled={busy} onClick={() => signOut().catch((e) => toast(String(e), "error"))}>
          <LogOut size={15} /> {t("Sign out")}
        </button>
      </div>
      {locked && <p className="mt-2 text-xs text-faint">{t("Downloading is disabled while a locked block is running.")}</p>}
      <p className="mt-3 text-xs text-faint">{t("Running blocks and statistics aren't synced. Community lists are downloaded again on each computer.")}</p>
    </>
  );
}
