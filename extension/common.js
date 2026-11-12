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

/** Id of the YouTube video a URL plays (watch, shorts, live, youtu.be), or null. */
function videoIdOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host !== "youtube.com") return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]{6,})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}
