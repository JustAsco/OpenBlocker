// Settings presets: one click instead of setting every blocking option by
// hand. They only touch options that decide how strict blocking is; language,
// theme, notifications and the tray stay as they are. While a locked block
// runs, the backend refuses a preset that would loosen anything.

import type { Settings } from "./types";

export type PresetId = "relaxed" | "balanced" | "strict" | "superStrict";

type BlockingSettings = Pick<
  Settings,
  | "blockSubdomains"
  | "freezeBlocksTaskManager"
  | "unlockTextLength"
  | "unlockTextStyle"
  | "requireExtension"
  | "suggestExtension"
  | "hideShortVideoFeeds"
  | "extensionFallback"
  | "privateWindows"
  | "superStrict"
>;

export const PRESETS: { id: PresetId; name: string; description: string; settings: BlockingSettings }[] = [
  {
    id: "relaxed",
    name: "Relaxed",
    description: "Gentle nudges. Short unlock texts, browsers are never closed, extension-only features stay open without it.",
    settings: {
      blockSubdomains: true,
      freezeBlocksTaskManager: false,
      unlockTextLength: 40,
      unlockTextStyle: "random",
      requireExtension: false,
      suggestExtension: true,
      hideShortVideoFeeds: false,
      extensionFallback: "lenient",
      privateWindows: "off",
      superStrict: false,
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "The defaults. Blocks hold, but OpenBlocker only closes a browser if you switch the extension off during a block.",
    settings: {
      blockSubdomains: true,
      freezeBlocksTaskManager: true,
      unlockTextLength: 120,
      unlockTextStyle: "random",
      requireExtension: false,
      suggestExtension: true,
      hideShortVideoFeeds: true,
      extensionFallback: "strict",
      privateWindows: "default",
      superStrict: false,
    },
  },
  {
    id: "strict",
    name: "Strict",
    description: "While websites are blocked, browsers without the extension are closed after a minute. Private windows count, longer reflection texts.",
    settings: {
      blockSubdomains: true,
      freezeBlocksTaskManager: true,
      unlockTextLength: 250,
      unlockTextStyle: "reflection",
      requireExtension: true,
      suggestExtension: true,
      hideShortVideoFeeds: true,
      extensionFallback: "strict",
      privateWindows: "on",
      superStrict: false,
    },
  },
  {
    id: "superStrict",
    name: "Super strict",
    description: "During any block, every browser needs the extension (also in private windows) or it's closed after 15 seconds.",
    settings: {
      blockSubdomains: true,
      freezeBlocksTaskManager: true,
      unlockTextLength: 400,
      unlockTextStyle: "reflection",
      requireExtension: true,
      suggestExtension: true,
      hideShortVideoFeeds: true,
      extensionFallback: "strict",
      privateWindows: "on",
      superStrict: true,
    },
  },
];

/** The preset the settings match exactly, or null ("Custom"). */
export function currentPreset(s: Settings): PresetId | null {
  return PRESETS.find((p) => (Object.keys(p.settings) as (keyof BlockingSettings)[]).every((k) => s[k] === p.settings[k]))?.id ?? null;
}

/** Would switching from `s` to this preset loosen anything (refused during a lock)? */
export function loosens(s: Settings, preset: BlockingSettings): boolean {
  const rank = { off: 0, default: 1, on: 2 } as const;
  return (
    (s.blockSubdomains && !preset.blockSubdomains) ||
    (s.hideShortVideoFeeds && !preset.hideShortVideoFeeds) ||
    (s.requireExtension && !preset.requireExtension) ||
    (s.superStrict && !preset.superStrict) ||
    (s.extensionFallback === "strict" && preset.extensionFallback === "lenient") ||
    rank[preset.privateWindows] < rank[s.privateWindows] ||
    preset.unlockTextLength < s.unlockTextLength
  );
}
