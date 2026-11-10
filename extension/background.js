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
const MAX_PATH_RULES = 900;

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
    const params = new URLSearchParams({ b: browserHint(), v: VERSION, a: await activeUrl() });
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
    }
  }
}

async function apply(rules) {
  const key = rules.rev ?? JSON.stringify([rules.blocked, rules.blockedPaths, rules.allowOnly]);
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
