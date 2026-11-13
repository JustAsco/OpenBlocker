// Runs on YouTube, Instagram and Facebook.
// 1. While Shorts/Reels pages are blocked, also hides them in feeds, so they
//    don't tempt you in the first place.
// 2. While only some YouTube channels are allowed, hides thumbnails of all
//    other channels.
// 3. On YouTube, reports which channel the open video is from, as a fallback
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

// ───────────── Thumbnails of other channels ─────────────
//
// While only some channels are allowed, video tiles (home feed, search,
// recommendations, Shorts shelves) stay hidden until the background script
// confirms they're from an allowed channel. What's left is a YouTube that only
// shows allowed channels.

const TILES = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-playlist-video-renderer",
  "ytd-playlist-panel-video-renderer",
  "ytd-reel-item-renderer",
  "ytd-compact-autoplay-renderer",
  "yt-lockup-view-model",
  "ytm-shorts-lockup-view-model",
  "ytm-shorts-lockup-view-model-v2",
  "ytm-video-with-context-renderer",
  "ytm-compact-video-renderer",
  "ytm-media-item",
].join(",");
const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/UC"], a[href^="/c/"], a[href^="/user/"]';

const tileVerdicts = new Map(); // key -> allowed
let tileStyle = null;
let observer = null;
let tileTimer = null;
let tileRules = null;

/** Channel whose page this is ("/@name/videos" → "@name"), if any. */
function pageChannel() {
  const m = location.pathname.match(/^\/(@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)/);
  return m ? normalizeChannel(m[1]) : null;
}

function tileKey(tile) {
  const link = tile.querySelector(CHANNEL_LINK);
  const channel = link && normalizeChannel(link.getAttribute("href"));
  if (channel) return "c:" + channel;
  const video = tile.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
  const id = video && videoIdOf(new URL(video.getAttribute("href"), location.origin).href);
  if (id) {
    // Videos on a channel's own page carry no channel link.
    const own = pageChannel();
    return own ? "c:" + own : "v:" + id;
  }
  return null;
}

async function filterTiles() {
  tileTimer = null;
  const ask = new Set();
  const pending = [];
  for (const tile of document.querySelectorAll(TILES)) {
    const key = tileKey(tile);
    // YouTube reuses tile elements for other videos: re-check when the key changes.
    if (!key || tile.dataset.obKey === key) continue;
    tile.dataset.obKey = key;
    if (tileVerdicts.has(key)) {
      tile.dataset.obOk = tileVerdicts.get(key) ? "1" : "0";
    } else {
      delete tile.dataset.obOk;
      ask.add(key);
      pending.push(tile);
    }
  }
  if (!ask.size) return;
  const answers = await api.runtime.sendMessage({ type: "yt-tiles", keys: [...ask] }).catch(() => null);
  if (!answers) return;
  for (const [k, v] of Object.entries(answers)) {
    tileVerdicts.set(k, v);
    if (tileVerdicts.size > 3000) tileVerdicts.delete(tileVerdicts.keys().next().value);
  }
  for (const tile of pending) {
    const v = tileVerdicts.get(tile.dataset.obKey);
    if (v !== undefined) tile.dataset.obOk = v ? "1" : "0";
  }
}

function scheduleTiles() {
  if (!tileTimer) tileTimer = setTimeout(filterTiles, 250);
}

function applyTileFilter(rules, subs) {
  // The key changes whenever the allowed channels do (including newly read
  // subscriptions), which re-checks every tile. With only subscriptions
  // allowed the picked list is empty, so don't test it for truthiness.
  const channels =
    rules?.youtubeChannels && /(^|\.)youtube\.com$/.test(location.hostname)
      ? rules.youtubeChannels.join() + (rules.youtubeSubscriptions ? `|subs:${subs?.status}:${subs?.ids?.length}:${subs?.at}` : "")
      : null;
  if (channels === tileRules) return;
  tileRules = channels;
  tileVerdicts.clear();
  for (const tile of document.querySelectorAll("[data-ob-key]")) {
    delete tile.dataset.obKey;
    delete tile.dataset.obOk;
  }
  if (channels === null) {
    tileStyle?.remove();
    tileStyle = null;
    observer?.disconnect();
    observer = null;
    return;
  }
  if (!tileStyle) {
    tileStyle = document.createElement("style");
    tileStyle.id = "openblocker-channels";
    tileStyle.textContent = `:is(${TILES}):not([data-ob-ok="1"]) { display: none !important; }`;
  }
  if (!tileStyle.isConnected) (document.head || document.documentElement).append(tileStyle);
  if (!observer) {
    observer = new MutationObserver(scheduleTiles);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  }
  scheduleTiles();
}

// ───────────── Subscribed channels ─────────────
//
// While a list allows "channels I'm subscribed to", read the subscriptions
// from the "All subscriptions" page and hand them to the background script.
// This runs here, as the page, because only the page is signed in.

const SUBS_MAX_AGE = 30 * 60 * 1000;
const SUBS_RETRY = 2 * 60 * 1000;
let subsLoading = false;
// Firefox runs content-script fetches as the extension; `content.fetch` runs them as the page.
const pageFetch = typeof content !== "undefined" && content?.fetch ? content.fetch.bind(content) : fetch.bind(globalThis);

/** Authorization header YouTube's own web client sends with signed-in API requests. */
async function sapisidHash() {
  const sid = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ?? document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
  if (!sid) return null;
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${ts} ${sid} ${location.origin}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}

async function readSubscriptions() {
  const res = await pageFetch("/feed/channels", { credentials: "same-origin" });
  if (!res.ok) return { status: "error" };
  const html = await res.text();
  if (!signedIn(html)) return { status: "signed-out" };
  const first = collectSubscriptions(jsonAfter(html, "ytInitialData = ") ?? jsonAfter(html, "ytInitialData="));
  // Signed in but no channel entries and none in the page at all: YouTube changed the page.
  if (!first.ids.length && !html.includes("channelRenderer")) return { status: "error" };
  const ids = new Set(first.ids);
  let token = first.token;
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const context = jsonAfter(html, '"INNERTUBE_CONTEXT":');
  // Later batches ("load more") come from YouTube's own API.
  for (let page = 0; token && context && page < 100; page++) {
    const auth = await sapisidHash();
    const r = await pageFetch(`/youtubei/v1/browse?prettyPrint=false${key ? "&key=" + encodeURIComponent(key) : ""}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Goog-AuthUser": "0", "X-Origin": location.origin, ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ context, continuation: token }),
    });
    if (!r.ok) break; // keep what we have
    const next = collectSubscriptions(await r.json());
    next.ids.forEach((i) => ids.add(i));
    token = next.token;
  }
  return { status: "ok", ids: [...ids], complete: !token };
}

async function maybeReadSubscriptions(rules) {
  // Only on www.youtube.com: the mobile site renders a different page.
  if (!rules?.youtubeSubscriptions || subsLoading || location.hostname !== "www.youtube.com") return;
  const { ytSubs, ytSubsClaim } = await api.storage.local.get(["ytSubs", "ytSubsClaim"]);
  const age = ytSubs ? Date.now() - ytSubs.at : Infinity;
  if (age < (ytSubs?.status === "ok" ? SUBS_MAX_AGE : SUBS_RETRY)) return;
  // Several YouTube tabs: one reads, the others wait.
  if (ytSubsClaim && Date.now() - ytSubsClaim < 60_000) return;
  subsLoading = true;
  try {
    await api.storage.local.set({ ytSubsClaim: Date.now() });
    const result = await readSubscriptions().catch(() => ({ status: "error" }));
    await api.runtime.sendMessage({ type: "yt-subs", ...result }).catch(() => {});
  } finally {
    subsLoading = false;
    await api.storage.local.set({ ytSubsClaim: 0 }).catch(() => {});
  }
}

async function refresh() {
  const { rules, ytSubs } = await api.storage.local.get(["rules", "ytSubs"]);
  applyFeedCss(rules);
  applyTileFilter(rules, ytSubs);
  maybeReadSubscriptions(rules);
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
