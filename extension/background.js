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
    if (lastRules?.youtubeSubscriptions) {
      const subs = await subscriptions();
      if (subs) params.set("ys", subs.status === "ok" ? String(subs.ids.length) : "-1");
    }
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { "X-OpenBlocker": "1" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let rules = await res.json();
    maybeUpdate(rules.latestVersion);
    if (rules.privateWindowsRequired && !incognito) explainPrivateWindows();
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

/** Is version a older than b ("0.2.0" < "0.10.0")? */
function older(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

/**
 * The app ships a newer extension: update. A store install asks the store;
 * an unpacked one reloads itself, which re-reads its folder (the installer
 * has put the new files there). Tried once per version, so an extension
 * loaded from some other folder doesn't reload forever; the app then shows
 * that it's outdated.
 */
let updateChecked = null;
async function maybeUpdate(latest) {
  if (!latest || !older(VERSION, latest) || updateChecked === latest) return;
  updateChecked = latest;
  const { reloadedFor } = await api.storage.local.get("reloadedFor");
  if (reloadedFor === latest) return;
  await api.storage.local.set({ reloadedFor: latest });
  if (api.runtime.getManifest().update_url && api.runtime.requestUpdateCheck) {
    // Installed from a store: Chrome downloads it and onUpdateAvailable reloads.
    api.runtime.requestUpdateCheck().catch(() => {});
    return;
  }
  api.runtime.reload();
}
api.runtime.onUpdateAvailable?.addListener(() => api.runtime.reload());

/** Opens the "allow in private windows" page, once per browser session. */
let privateExplained = false;
async function explainPrivateWindows() {
  if (privateExplained) return;
  privateExplained = true;
  const url = api.runtime.getURL("private.html");
  const open = await api.tabs.query({ url }).catch(() => []);
  if (!open.length) api.tabs.create({ url }).catch(() => {});
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
const channelIds = new Map(); // "@handle" / "c/name" / "user/name" -> "UC…" id
const inflight = new Map(); // running lookups, so each is only fetched once

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > 3000) map.delete(map.keys().next().value);
}

// At most a few lookups at a time: a feed full of thumbnails must not turn
// into a flood of requests.
let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve) => {
    queue.push(() => fn().then(resolve, () => resolve(null)));
    pump();
  });
}
function pump() {
  while (active < 4 && queue.length) {
    active++;
    queue.shift()().finally(() => {
      active--;
      pump();
    });
  }
}

function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

function lookupVideo(videoId) {
  if (videoChannels.has(videoId)) return Promise.resolve(videoChannels.get(videoId));
  return once("v" + videoId, () =>
    limited(async () => {
      const watch = `https://www.youtube.com/watch?v=${videoId}`;
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`);
      if (!res.ok) return null; // e.g. embedding disabled: the page reports it
      const channel = normalizeChannel((await res.json()).author_url);
      if (channel) remember(videoChannels, videoId, channel);
      return channel;
    }),
  );
}

/** "UC…" id of a channel given as @handle (or legacy name), via its page. */
function channelIdOf(ref) {
  if (ref.startsWith("UC")) return Promise.resolve(ref);
  if (channelIds.has(ref)) return Promise.resolve(channelIds.get(ref));
  return once("c" + ref, () =>
    limited(async () => {
      const html = await (await fetch(`https://www.youtube.com/${ref}`, { credentials: "include" })).text();
      const id =
        html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
        html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
        null;
      // Only answers are cached; a failed request is tried again next time.
      if (id) remember(channelIds, ref, id);
      return id;
    }),
  );
}

// ───────────── Subscribed channels ─────────────
//
// The content script on youtube.com reads the subscriptions (it runs as the
// page, so it's signed in like the user) and sends them here. We keep them in
// storage: { status: "ok" | "signed-out" | "error", ids: ["UC…"], at }.

let subsCache;
async function subscriptions() {
  if (subsCache === undefined) subsCache = (await api.storage.local.get("ytSubs")).ytSubs ?? null;
  return subsCache;
}

const DAY = 24 * 60 * 60 * 1000;
async function storeSubscriptions(msg) {
  const old = await subscriptions();
  // While a locked block allows subscriptions, subscribing to a new channel
  // mustn't open it: a refresh may only drop channels (unsubscribed), never
  // add any. A recent successful list is the baseline.
  const baseline = current?.youtubeSubscriptionsLocked && old?.status === "ok" && Date.now() - old.at < DAY ? new Set(old.ids) : null;
  let next;
  if (msg.status === "ok") {
    let ids = (Array.isArray(msg.ids) ? msg.ids : []).filter((i) => typeof i === "string" && /^UC[\w-]{22}$/.test(i)).slice(0, 20000);
    if (baseline) ids = ids.filter((i) => baseline.has(i));
    next = { status: "ok", ids, at: Date.now(), complete: !!msg.complete };
  } else if (baseline) {
    // Couldn't read them right now (signed out, page changed): keep the list from before the lock.
    next = { ...old, at: Date.now() };
  } else {
    next = { status: msg.status === "signed-out" ? "signed-out" : "error", ids: [], at: Date.now() };
  }
  subsCache = next;
  await api.storage.local.set({ ytSubs: next });
}

/** Channels whose videos may play right now (picked ones plus subscriptions), or null without a restriction. */
async function allowedChannels({ waitForSubscriptions = false } = {}) {
  const picked = current?.youtubeChannels;
  if (!picked) return null;
  if (!current.youtubeSubscriptions) return picked;
  let subs = await subscriptions();
  // Right after YouTube opens, the content script is still reading them:
  // wait a little rather than blocking a video from a subscribed channel.
  for (let i = 0; !subs && waitForSubscriptions && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    subs = await subscriptions();
  }
  return subs?.status === "ok" || subs?.ids?.length ? [...picked, ...subs.ids] : picked;
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

const lastRedirect = new Map(); // tab id -> { videoId, at }

async function checkVideo(tabId, url) {
  const videoId = current?.youtubeChannels && videoIdOf(url);
  if (!videoId) return;
  const allowed = await allowedChannels({ waitForSubscriptions: true });
  if (!allowed) return;
  const channel = (await lookupVideo(videoId)) ?? pageChannels.get(videoId);
  // Unknown yet: the content script reports it once the page shows it.
  if (!channel || (await channelAllowed(channel, allowed))) return;
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || videoIdOf(tab.url) !== videoId || !current?.youtubeChannels) return;
  // Several checks can finish for the same navigation: redirect once.
  const last = lastRedirect.get(tabId);
  if (last && last.videoId === videoId && Date.now() - last.at < 5000) return;
  lastRedirect.set(tabId, { videoId, at: Date.now() });
  api.tabs.update(tabId, { url: `${BLOCK_PAGE}?r=channel&c=${encodeURIComponent(channel)}#${tab.url}` }).catch(() => {});
}

/** For the content script: which thumbnails may be shown ("c:<channel>" or "v:<video id>" keys). */
async function tilesAllowed(keys) {
  const allowed = await allowedChannels({ waitForSubscriptions: true });
  const out = {};
  await Promise.all(
    keys.slice(0, 200).map(async (key) => {
      if (!allowed) return (out[key] = true);
      const channel = key.startsWith("c:") ? key.slice(2) : ((await lookupVideo(key.slice(2))) ?? pageChannels.get(key.slice(2)));
      out[key] = !!channel && (await channelAllowed(channel, allowed));
    }),
  );
  return out;
}

api.tabs.onRemoved.addListener((tabId) => lastRedirect.delete(tabId));

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "yt-channel" && sender.tab?.id !== undefined) {
    const channel = normalizeChannel(msg.channel);
    if (channel && typeof msg.videoId === "string") {
      remember(pageChannels, msg.videoId, channel);
      checkVideo(sender.tab.id, sender.tab.url);
    }
  } else if (msg?.type === "yt-subs" && sender.tab) {
    storeSubscriptions(msg).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  } else if (msg?.type === "channel-allowed" && typeof msg.channel === "string") {
    // For the block page: may this channel play now (e.g. subscriptions loaded meanwhile)?
    allowedChannels()
      .then((allowed) => {
        if (!allowed) return true;
        const channel = normalizeChannel(msg.channel);
        return channel ? channelAllowed(channel, allowed) : false;
      })
      .then(sendResponse, () => sendResponse(false));
    return true;
  } else if (msg?.type === "yt-embed" && typeof msg.videoId === "string") {
    // A YouTube player embedded on another website: may this video play?
    (async () => {
      const allowed = await allowedChannels({ waitForSubscriptions: true });
      if (!allowed) return { allowed: true };
      const channel = await lookupVideo(msg.videoId);
      // Unknown channel while channels are restricted: don't play it.
      return { allowed: !!channel && (await channelAllowed(channel, allowed)), channel };
    })().then(sendResponse, () => sendResponse({ allowed: false }));
    return true;
  } else if (msg?.type === "yt-tiles" && Array.isArray(msg.keys)) {
    tilesAllowed(msg.keys.filter((k) => typeof k === "string")).then(sendResponse, () => sendResponse({}));
    return true; // answers asynchronously
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
