// Shared by the background script and the block page.
var api = globalThis.browser ?? globalThis.chrome;

// Always reachable, even under an allowlist.
var ALWAYS_ALLOWED = ["localhost", "127.0.0.1"];

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

// Community lists can hold 100k+ domains: look them up in a Set, checking
// the host and each parent domain (a.b.example.com, b.example.com, …).
var domainSets = new WeakMap();
function domainMatches(host, domains) {
  let set = domainSets.get(domains);
  if (!set) {
    set = new Set(domains);
    domainSets.set(domains, set);
  }
  for (let h = host; h; h = h.slice(h.indexOf(".") + 1 || h.length)) {
    if (set.has(h)) return true;
    if (!h.includes(".")) break;
  }
  return false;
}

/** Does the URL fall under a path rule like "youtube.com/shorts"? */
function pathMatches(url, host, paths) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return false;
  }
  return paths.some((p) => {
    const i = p.indexOf("/");
    const prefix = p.slice(i);
    return domainMatches(host, [p.slice(0, i)]) && (path === prefix || path.startsWith(prefix + "/"));
  });
}

/** Would `rules` block this URL? */
function isBlocked(url, rules) {
  const host = hostOf(url);
  if (!host || !rules) return false;
  // List exceptions (reddit.com/r/rust) win over blocked sites.
  if (pathMatches(url, host, rules.allowedPaths || [])) return false;
  if (domainMatches(host, rules.blocked || [])) return true;
  if (pathMatches(url, host, rules.blockedPaths || [])) return true;
  if (rules.allowOnly && !domainMatches(host, [...rules.allowOnly, ...ALWAYS_ALLOWED])) return true;
  return false;
}

// ───────────── YouTube channels ─────────────

/**
 * Canonical form of a YouTube channel reference: "@handle" (lowercase),
 * "UC…" channel id, or "c/name" / "user/name". Mirrors `normalize_channel`
 * in src-tauri/core/src/hosts.rs.
 */
function normalizeChannel(input) {
  let s = String(input || "").trim();
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  const lower = s.toLowerCase();
  const host = ["www.youtube.com/", "m.youtube.com/", "youtube.com/", "music.youtube.com/"].find((p) => lower.startsWith(p));
  const wasUrl = !!host || scheme >= 0 || /[?#]/.test(s);
  if (host) s = s.slice(host.length);
  s = s.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  const ok = (t) => !!t && t.length <= 100 && /^[A-Za-z0-9._-]+$/.test(t);
  const isId = (t) => !!t && t.length === 24 && t.startsWith("UC") && ok(t);
  const first = parts[0] || "";
  if (first === "channel") return isId(parts[1]) ? parts[1] : null;
  if (first === "c" || first === "user") return ok(parts[1]) ? `${first}/${parts[1].toLowerCase()}` : null;
  if (first.startsWith("@") && ok(first.slice(1))) return first.toLowerCase();
  if (isId(first)) return first;
  if (!wasUrl && !s.includes("/") && ok(first) && !first.includes(".")) return "@" + first.toLowerCase();
  return null;
}

/** Id of the YouTube video a URL plays (watch, shorts, live, embed, youtu.be), or null. */
function videoIdOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    // Embedded players; "videoseries" is a playlist without a single video id.
    const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
    return m && m[2] !== "videoseries" ? m[2] : null;
  } catch {
    return null;
  }
}

// ───────────── YouTube subscriptions ─────────────
//
// "Subscribed channels only" reads the signed-in user's subscriptions from
// YouTube's "All subscriptions" page (youtube.com/feed/channels). The page
// embeds its data as JSON; rather than relying on exactly where YouTube puts
// things (it moves them around), we walk the whole tree for channel entries
// and the token that loads the next batch.

/** The JSON object or array that starts at `start` in `text` (balanced brackets, strings respected). */
function jsonAt(text, start) {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** JSON value assigned after `marker` in a page, e.g. `ytInitialData = {…}` or `"INNERTUBE_CONTEXT":{…}`. */
function jsonAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.slice(at + marker.length).search(/[{[]/);
  return start < 0 ? null : jsonAt(text, at + marker.length + start);
}

/** Channel ids ("UC…") of subscription entries and the continuation token in YouTube page data. */
function collectSubscriptions(data) {
  const ids = new Set();
  let token = null;
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 60 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    for (const key of ["channelRenderer", "gridChannelRenderer"]) {
      const id = node[key]?.channelId;
      if (typeof id === "string" && /^UC[\w-]{22}$/.test(id)) ids.add(id);
    }
    const t = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof t === "string" && !token) token = t;
    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(data, 0);
  return { ids: [...ids], token };
}

/** Whether the page was rendered for a signed-in user. */
function signedIn(html) {
  return /"LOGGED_IN":\s*true/.test(html);
}
