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
  if (domainMatches(host, rules.blocked || [])) return true;
  if (pathMatches(url, host, rules.blockedPaths || [])) return true;
  if (rules.allowOnly && !domainMatches(host, [...rules.allowOnly, ...ALWAYS_ALLOWED])) return true;
  return false;
}
