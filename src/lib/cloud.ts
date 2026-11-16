// Optional cloud sync through Supabase. Only lists, categories, schedules,
// limits and settings are synced (see engine::Backup); running blocks and
// statistics stay on this computer.
//
// Sync is off unless the build sets VITE_SUPABASE_URL and
// VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example). Then the account section
// in Settings doesn't appear and OpenBlocker never contacts a server.
// Sign-in uses email and password without a confirmation email, so it works
// without an email server (SMTP) and without a redirect URL or deep link.
// Google sign-in or emailed codes can be added next to it later. The PKCE
// flow makes links in emails (sign-up confirmation) carry a one-time code
// instead of session tokens, so the page they redirect to gets nothing usable.

import type { Session, SupabaseClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Whether this build can sync at all. */
export const cloudEnabled = !!URL && !!KEY;

let client: Promise<SupabaseClient> | null = null;

/** Loaded on first use, so builds and sessions without sync don't pay for it. */
function supabase(): Promise<SupabaseClient> {
  if (!cloudEnabled) return Promise.reject("Cloud sync isn't available in this build.");
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(URL!, KEY!, { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "ob-cloud-auth" } }),
  );
  return client;
}

function fail(error: { message: string } | null): void {
  if (error) throw error.message;
}

/** Calls `cb` with the current session (or null) and on every change. */
export function onSession(cb: (s: Session | null) => void): () => void {
  if (!cloudEnabled) return () => {};
  let off = () => {};
  let cancelled = false;
  supabase().then((sb) => {
    if (cancelled) return;
    sb.auth.getSession().then(({ data }) => !cancelled && cb(data.session));
    const { data } = sb.auth.onAuthStateChange((_event, session) => cb(session));
    off = () => data.subscription.unsubscribe();
  });
  return () => {
    cancelled = true;
    off();
  };
}

/** Signs in with email and password. */
export async function signIn(email: string, password: string): Promise<void> {
  const sb = await supabase();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  fail(error);
}

/**
 * Creates an account. Returns false when the project still requires email
 * confirmation (Authentication → Sign In / Providers → Email → "Confirm
 * email"): then there's no session until the link in the email is opened.
 */
export async function signUp(email: string, password: string): Promise<boolean> {
  const sb = await supabase();
  const { data, error } = await sb.auth.signUp({ email, password });
  fail(error);
  return !!data.session;
}

export async function signOut(): Promise<void> {
  const sb = await supabase();
  const { error } = await sb.auth.signOut();
  fail(error);
}

export interface CloudCopy {
  data: unknown;
  /** Unix ms. */
  updatedAt: number;
}

/** The copy in the cloud, or null if nothing was uploaded yet. */
export async function download(): Promise<CloudCopy | null> {
  const sb = await supabase();
  const { data, error } = await sb.from("backups").select("data, updated_at").maybeSingle();
  fail(error);
  return data ? { data: data.data, updatedAt: Date.parse(data.updated_at) } : null;
}

/** Replaces the copy in the cloud. Returns when it was stored (Unix ms). */
export async function upload(backup: unknown): Promise<number> {
  const sb = await supabase();
  const { data: user } = await sb.auth.getUser();
  if (!user.user) throw "Please sign in again.";
  const { data, error } = await sb.from("backups").upsert({ user_id: user.user.id, data: backup }).select("updated_at").single();
  fail(error);
  return Date.parse(data!.updated_at);
}
