// Translations. The English text is the key: `t("Saved.")`. Missing
// translations fall back to English, so new UI text never breaks anything.
// Placeholders in braces are filled from `params`: t("{n} apps", { n: 3 }).
//
// The language is a setting (Settings → App), cached in localStorage so it's
// known before the first snapshot arrives; changing it reloads the window.
// To add a language: copy src/locales/de.ts, translate, and list it in LANGUAGES.

import { Fragment, createElement, type ReactNode } from "react";
import de from "../locales/de";

export const LANGUAGES: { code: string; name: string; dict: Record<string, string> }[] = [
  { code: "en", name: "English", dict: {} },
  { code: "de", name: "Deutsch", dict: de },
];

const CACHE_KEY = "ob-lang";

/** "" (follow the system) → a supported language code. */
export function resolveLanguage(setting: string): string {
  const pick = (code: string) => LANGUAGES.find((l) => l.code === code.slice(0, 2).toLowerCase())?.code;
  return (setting && pick(setting)) || pick(navigator.language || "en") || "en";
}

function cached(): string {
  try {
    return localStorage.getItem(CACHE_KEY) ?? "";
  } catch {
    return "";
  }
}

let lang = resolveLanguage(cached());
let dict = LANGUAGES.find((l) => l.code === lang)!.dict;
document.documentElement.lang = lang;

/** The active language code. */
export const language = () => lang;

/** Called with the language setting from each snapshot; reloads on change. */
export function syncLanguage(setting: string) {
  const want = resolveLanguage(setting);
  try {
    if (cached() !== setting) localStorage.setItem(CACHE_KEY, setting);
  } catch {
    /* private mode: the setting still applies after the reload */
  }
  if (want !== lang) location.reload();
}

export function t(text: string, params?: Record<string, string | number>): string {
  let out = dict[text] ?? text;
  if (params) for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

let patterns: { re: RegExp; names: string[]; key: string }[] | null = null;

/**
 * Translates a finished message, e.g. an error from the backend that already
 * has names and times filled in: keys with {placeholders} match any text in
 * their place ("“{name}” is locked until {time}." matches "“Games” is locked
 * until 17:30.").
 */
export function translateMessage(message: string): string {
  if (dict[message]) return dict[message];
  patterns ??= Object.keys(dict)
    .filter((k) => /\{\w+\}/.test(k))
    .map((key) => {
      const names: string[] = [];
      const src = key
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (m) {
            names.push(m[1]);
            return "(.+?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("");
      return { re: new RegExp(`^${src}$`, "s"), names, key };
    });
  for (const p of patterns) {
    const m = p.re.exec(message);
    if (m) return t(p.key, Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])));
  }
  return message;
}

/**
 * Like t(), but placeholders can be React elements:
 * tx("{what} is {locked} {until}.", { what, locked: <b>{t("locked")}</b>, until }).
 */
export function tx(text: string, params: Record<string, ReactNode>): ReactNode {
  return t(text)
    .split(/(\{\w+\})/)
    .map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      return createElement(Fragment, { key: i }, m && m[1] in params ? params[m[1]] : part);
    });
}
