/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL for optional cloud sync (see .env.example). */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (anon) key. Public by design: row-level security protects the data. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
