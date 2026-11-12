// Runs on YouTube, Instagram and Facebook.
// 1. While Shorts/Reels pages are blocked, also hides them in feeds, so they
//    don't tempt you in the first place.
// 2. On YouTube, reports which channel the open video is from, as a fallback
//    for when the background script can't look it up (e.g. videos that don't
//    allow embedding). The background script decides whether to block.
//
// YouTube and Meta rename their page elements now and then; the selectors
// below are best effort and need updating when that happens.

const FEED_CSS = [
  {
    // Blocked path that turns this on, and the CSS that hides it in feeds.
    path: "youtube.com/shorts",
    css: `
      ytd-reel-shelf-renderer,
      ytd-rich-shelf-renderer[is-shorts],
      ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
      ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model),
      ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2),
      grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
      grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2),
      ytd-rich-item-renderer:has(a[href^="/shorts/"]),
      ytd-video-renderer:has(a[href^="/shorts/"]),
      ytd-grid-video-renderer:has(a[href^="/shorts/"]),
      ytd-compact-video-renderer:has(a[href^="/shorts/"]),
      ytd-guide-entry-renderer:has(a[title="Shorts"]),
      ytd-guide-entry-renderer:has(a[href="/shorts"]),
      ytd-mini-guide-entry-renderer[aria-label="Shorts"],
      ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
      yt-tab-shape[tab-title="Shorts"],
      ytm-reel-shelf-renderer,
      ytm-shorts-lockup-view-model,
      ytm-pivot-bar-item-renderer:has(.pivot-shorts)`,
  },
  {
    path: "instagram.com/reels",
    css: `a[href="/reels/"], a[href^="/reels/"], a[href^="/reel/"]`,
  },
  {
    path: "facebook.com/reel",
    css: `a[href*="/reel/"], a[href*="/reels/"], [aria-label="Reels"]`,
  },
];

let style = null;

function applyFeedCss(rules) {
  const css = rules?.hideShortVideoFeeds
    ? FEED_CSS.filter((f) => {
        const domain = f.path.split("/")[0];
        if (!domainMatches(location.hostname.replace(/^www\./, ""), [domain])) return false;
        // Blocked as a path, or the whole site is blocked anyway.
        return isBlocked(`https://${f.path}/x`, { blocked: [], blockedPaths: rules.blockedPaths || [] });
      })
        .map((f) => `${f.css} { display: none !important; }`)
        .join("\n")
    : "";
  if (!css) {
    style?.remove();
    style = null;
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "openblocker-feeds";
  }
  if (style.textContent !== css) style.textContent = css;
  if (!style.isConnected) (document.head || document.documentElement).append(style);
}

// ───────────── YouTube channel of the open video ─────────────

const OWNER_SELECTORS = [
  // Shorts player (the active one).
  "ytd-reel-video-renderer[is-active] ytd-channel-name a",
  "ytd-reel-video-renderer[is-active] a.ytReelChannelBarViewModelChannelName",
  "ytd-reel-video-renderer[is-active] a[href^='/@']",
  // Watch page.
  "ytd-watch-metadata ytd-channel-name a",
  "ytd-watch-metadata ytd-video-owner-renderer a[href^='/@']",
  "ytd-video-owner-renderer a[href^='/channel/']",
  // Mobile site.
  "ytm-slim-owner-renderer a",
];

let lastReport = "";

function reportChannel() {
  const videoId = videoIdOf(location.href);
  if (!videoId) return;
  // Right after switching videos the old owner is still on the page: wait
  // until the player shows the new video.
  const flexy = document.querySelector("ytd-watch-flexy");
  if (location.pathname === "/watch" && flexy && flexy.getAttribute("video-id") !== videoId) return;
  for (const sel of OWNER_SELECTORS) {
    const href = document.querySelector(sel)?.getAttribute("href");
    const channel = href && normalizeChannel(href);
    if (channel) {
      const key = videoId + channel;
      if (key !== lastReport) {
        lastReport = key;
        api.runtime.sendMessage({ type: "yt-channel", videoId, channel }).catch(() => {});
      }
      return;
    }
  }
}

async function refresh() {
  const { rules } = await api.storage.local.get("rules");
  applyFeedCss(rules);
  if (rules?.youtubeChannels && /(^|\.)youtube\.com$/.test(location.hostname)) reportChannel();
}

api.storage.onChanged.addListener((changes) => {
  if (changes.rules) refresh();
});
// YouTube is a single-page app: the page changes without reloading.
document.addEventListener("yt-navigate-finish", () => {
  lastReport = "";
  refresh();
});
setInterval(refresh, 1500);
refresh();
