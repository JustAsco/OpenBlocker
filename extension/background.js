// OpenBlocker extension: pulls the active rules from the desktop app and
// enforces them with declarativeNetRequest. Open tabs are re-checked whenever
// the rules change, so blocks apply to already-open websites immediately.

if (typeof isBlocked === "undefined" && typeof importScripts === "function") importScripts("common.js");

const ENDPOINT = "http://127.0.0.1:47613/v1/rules";
const VERSION = api.runtime.getManifest().version;
const BLOCK_PAGE = api.runtime.getURL("blocked.html");
const POLL_MS = 2000;
const EMPTY = { blocked: [], blockedPaths: [], allowOnly: null, until: null, lists: [] };
// Browsers cap regex rules (Chrome: 1000); leave room for the other rules.
const MAX_PATH_RULES = 700;
const MAX_EXCEPTION_RULES = 200;

let current = null; // rules currently installed
let currentKey = null;

function browserHint() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(" ");
  if (ua.includes("Firefox/")) return "firefox";
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("OPR/") || /Opera/i.test(brands)) return "opera";
  if (navigator.brave || /Brave/i.test(brands)) return "brave";
  if (/Vivaldi/i.test(brands)) return "vivaldi";
  return "chrome";
}

/**
 * URL of the active tab while a browser window has focus and the user isn't
 * idle, so OpenBlocker can count time for usage limits. Nothing else about
 * your browsing is sent, and it only goes to the app on this computer.
 */
async function activeUrl() {
  try {
    if ((await api.idle.queryState(60)) !== "active") return "";
    const win = await api.windows.getLastFocused();
    if (!win?.focused) return "";
    const [tab] = await api.tabs.query({ active: true, windowId: win.id });
    return tab?.url && /^https?:/.test(tab.url) ? tab.url : "";
  } catch {
    return "";
  }
}

let lastRules = null; // last full rules (with rev), to reuse when unchanged

async function fetchRules() {
  try {
    const incognito = await api.extension.isAllowedIncognitoAccess().catch(() => false);
    const params = new URLSearchParams({ b: browserHint(), v: VERSION, a: await activeUrl(), i: incognito ? "1" : "0" });
    if (lastRules?.rev) params.set("r", lastRules.rev);
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { "X-OpenBlocker": "1" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let rules = await res.json();
    if (rules.unchanged && lastRules?.rev === rules.rev) {
      // Big community lists aren't resent every two seconds.
      rules = lastRules;
      await api.storage.local.set({ connected: true, checkedAt: Date.now() });
    } else {
      lastRules = rules;
      await api.storage.local.set({ rules, connected: true, checkedAt: Date.now() });
    }
    return rules;
  } catch {
    // App not reachable (closed or killed): keep enforcing the last known
    // rules until the blocks they belong to would have ended.
    const { rules } = await api.storage.local.get("rules");
    await api.storage.local.set({ connected: false, checkedAt: Date.now() });
    lastRules = null;
    return rules && rules.until && rules.until > Date.now() ? rules : EMPTY;
  }
}

function buildRules(rules) {
  const redirect = { type: "redirect", redirect: { regexSubstitution: BLOCK_PAGE + "#\\0" } };
  const out = [];
  if (rules.blocked.length) {
    out.push({
      id: 1,
      priority: 2,
      action: redirect,
      // requestDomains also matches every subdomain.
      condition: { regexFilter: "^https?://.*", requestDomains: rules.blocked, resourceTypes: ["main_frame", "sub_frame"] },
    });
  }
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  (rules.blockedPaths || []).slice(0, MAX_PATH_RULES).forEach((p, i) => {
    const slash = p.indexOf("/");
    out.push({
      id: 10 + i,
      priority: 2,
      action: redirect,
      condition: {
        // The path itself and everything below it, on the domain and its subdomains.
        regexFilter: `^https?://([^/?#]*\\.)?${escape(p.slice(0, slash))}(:[0-9]+)?${escape(p.slice(slash))}([/?#].*)?$`,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame", "sub_frame"],
      },
    });
  });
  // List exceptions such as reddit.com/r/rust: reachable although the site is blocked.
  (rules.allowedPaths || []).slice(0, MAX_EXCEPTION_RULES).forEach((p, i) => {
    const slash = p.indexOf("/");
    out.push({
      id: 5000 + i,
      priority: 3,
      action: { type: "allow" },
      condition: {
        regexFilter: `^https?://([^/?#]*\\.)?${escape(p.slice(0, slash))}(:[0-9]+)?${escape(p.slice(slash))}([/?#].*)?$`,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame", "sub_frame"],
      },
    });
  });
  if (rules.allowOnly) {
    out.push({
      id: 2,
      priority: 1,
      action: redirect,
      condition: {
        regexFilter: "^https?://.*",
        excludedRequestDomains: [...rules.allowOnly, ...ALWAYS_ALLOWED],
        resourceTypes: ["main_frame"],
      },
    });
  }
  return out;
}

async function sweepTabs(rules) {
  const tabs = await api.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && isBlocked(tab.url, rules)) {
      api.tabs.update(tab.id, { url: BLOCK_PAGE + "#" + tab.url }).catch(() => {});
    } else if (tab.url) {
      checkVideo(tab.id, tab.url);
    }
  }
}

// ───────────── YouTube channel allowlist ─────────────
//
// A video's address doesn't say who uploaded it, so each video is looked up
// once through YouTube's public oEmbed endpoint. If that fails (e.g. the
// video doesn't allow embedding), the content script reports the channel
// shown on the page. Videos embedded on other websites aren't checked yet
// (see the roadmap).

const videoChannels = new Map(); // video id -> channel (oEmbed)
const pageChannels = new Map(); // video id -> channel (reported by the page)
const channelIds = new Map(); // "@handle" / "c/name" / "user/name" -> "UC…" id (or null)

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > 2000) map.delete(map.keys().next().value);
}

async function lookupVideo(videoId) {
  if (videoChannels.has(videoId)) return videoChannels.get(videoId);
  try {
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`);
    if (res.ok) {
      const channel = normalizeChannel((await res.json()).author_url);
      if (channel) remember(videoChannels, videoId, channel);
      return channel;
    }
  } catch {
    /* offline or blocked: fall back to the page */
  }
  return null;
}

/** "UC…" id of a channel given as @handle (or legacy name), via its page. */
async function channelIdOf(ref) {
  if (ref.startsWith("UC")) return ref;
  if (channelIds.has(ref)) return channelIds.get(ref);
  let id = null;
  try {
    const html = await (await fetch(`https://www.youtube.com/${ref}`, { credentials: "include" })).text();
    id =
      html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
      html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
      null;
  } catch {
    /* unknown */
  }
  remember(channelIds, ref, id);
  return id;
}

async function channelAllowed(channel, allowed) {
  if (allowed.includes(channel)) return true;
  // The same channel can be named by @handle or by id: compare ids.
  const want = allowed.filter((a) => a.startsWith("UC"));
  if (channel.startsWith("UC")) {
    for (const a of allowed.filter((a) => !a.startsWith("UC"))) if ((await channelIdOf(a)) === channel) return true;
    return false;
  }
  if (!want.length) return false;
  const id = await channelIdOf(channel);
  return !!id && want.includes(id);
}

async function checkVideo(tabId, url) {
  const allowed = current?.youtubeChannels;
  const videoId = allowed && videoIdOf(url);
  if (!videoId) return;
  const channel = (await lookupVideo(videoId)) ?? pageChannels.get(videoId);
  // Unknown yet: the content script reports it once the page shows it.
  if (!channel || (await channelAllowed(channel, allowed))) return;
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || videoIdOf(tab.url) !== videoId || !current?.youtubeChannels) return;
  api.tabs.update(tabId, { url: `${BLOCK_PAGE}?r=channel&c=${encodeURIComponent(channel)}#${tab.url}` }).catch(() => {});
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "yt-channel" && sender.tab?.id !== undefined) {
    const channel = normalizeChannel(msg.channel);
    if (channel && typeof msg.videoId === "string") {
      remember(pageChannels, msg.videoId, channel);
      checkVideo(sender.tab.id, sender.tab.url);
    }
  }
});

async function apply(rules) {
  const key = rules.rev ?? JSON.stringify([rules.blocked, rules.blockedPaths, rules.allowedPaths, rules.allowOnly]);
  if (key === currentKey) return;
  const existing = await api.declarativeNetRequest.getDynamicRules();
  await api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: buildRules(rules),
  });
  current = rules;
  currentKey = key;
  await sweepTabs(rules);
}

let timer = null;
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await apply(await fetchRules());
  } catch (e) {
    console.warn("OpenBlocker:", e);
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(tick, POLL_MS);
  }
}

// Navigations that don't hit the network (back/forward cache, prerender, and
// single-page apps like YouTube switching to /shorts) skip
// declarativeNetRequest, so check URL changes as well.
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && current && isBlocked(info.url, current)) {
    api.tabs.update(tabId, { url: BLOCK_PAGE + "#" + info.url }).catch(() => {});
  } else if (info.url) {
    checkVideo(tabId, info.url);
  }
});

// Wake-up sources in case the background script was suspended.
api.alarms.create("openblocker-poll", { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(tick);
api.runtime.onStartup.addListener(tick);
api.runtime.onInstalled.addListener(async () => {
  // Firefox doesn't grant host access for MV3 extensions at install time.
  const granted = await api.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) api.tabs.create({ url: api.runtime.getURL("welcome.html") });
  tick();
});

tick();
