// Built-in knowledge used for autosuggestions and the factory categories.
// The data lives in src-tauri/core/catalog.json so Rust and the UI share it.

import raw from "../../src-tauri/core/catalog.json";
import type { AppEntry, Category } from "./types";

interface CatalogSite {
  domain: string;
  name: string;
  related?: string[];
}

interface CatalogCategory {
  id: string;
  name: string;
  icon: string;
  color: string;
  sites: CatalogSite[];
  /** `domain` is the app's website, used for its icon when it isn't installed. */
  /** `darkIcon`: the website icon is dark and needs a light background. */
  apps: (AppEntry & { domain?: string; darkIcon?: boolean })[];
}

export const CATALOG: CatalogCategory[] = (raw as { categories: CatalogCategory[] }).categories;

export interface SiteSuggestion extends CatalogSite {
  category: string;
}

export interface AppSuggestion extends AppEntry {
  category: string;
  domain?: string;
  darkIcon?: boolean;
}

export const SITES: SiteSuggestion[] = CATALOG.flatMap((c) => c.sites.map((s) => ({ ...s, category: c.id })));
export const APPS: AppSuggestion[] = CATALOG.flatMap((c) => c.apps.map((a) => ({ ...a, category: c.id })));

/** All domains for a site including related ones. */
export const expandSite = (s: CatalogSite) => [s.domain, ...(s.related ?? [])];

const NAMES = new Map(SITES.flatMap((s) => expandSite(s).map((d) => [d, s.name] as const)));
export const siteName = (domain: string) => NAMES.get(domain);

const APP_SITES = new Map(APPS.filter((a) => a.domain).map((a) => [a.exe.toLowerCase(), { domain: a.domain!, dark: !!a.darkIcon }] as const));
/** Website of a known app (by exe name), for showing its icon when the program isn't installed. */
export const appSite = (exe: string) => APP_SITES.get(exe.split(/[\\/]/).pop()!.toLowerCase());

/** Factory version of a built-in category (null for user-created ones). */
export function factoryCategory(id: string): Category | null {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) return null;
  return { id: c.id, name: c.name, icon: c.icon, color: c.color, sites: c.sites.flatMap(expandSite), apps: c.apps.map(({ name, exe }) => ({ name, exe })) };
}

export const defaultCategories = (): Category[] => CATALOG.map((c) => factoryCategory(c.id)!);

/** Fuzzy-ish score: prefix match beats substring match. */
export function score(query: string, ...fields: string[]): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let best = 0;
  for (const f of fields) {
    const t = f.toLowerCase();
    if (t === q) best = Math.max(best, 100);
    else if (t.startsWith(q)) best = Math.max(best, 80 - t.length / 10);
    else if (t.split(/[\s.\-_]/).some((w) => w.startsWith(q))) best = Math.max(best, 60 - t.length / 10);
    else if (t.includes(q)) best = Math.max(best, 40 - t.length / 10);
  }
  return best;
}
