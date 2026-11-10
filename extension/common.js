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

function domainMatches(host, domains) {
  return domains.some((d) => host === d || host.endsWith("." + d));
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
