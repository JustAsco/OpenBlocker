//! Hosts-file based website blocking. We own a clearly marked section of the
//! file and never touch anything outside of it.

use std::collections::BTreeSet;

pub const BEGIN_MARKER: &str = "# >>> OpenBlocker (managed section, do not edit) >>>";
pub const END_MARKER: &str = "# <<< OpenBlocker <<<";

/// Turns user input like `https://www.YouTube.com/watch?v=1` into `youtube.com`.
/// Returns `None` if the input is not a plausible domain.
pub fn normalize_domain(input: &str) -> Option<String> {
    let mut s = input.trim().to_lowercase();
    if let Some(i) = s.find("://") {
        s = s[i + 3..].to_string();
    }
    // Strip path, query, fragment, credentials and port.
    if let Some(i) = s.find(['/', '?', '#']) {
        s.truncate(i);
    }
    if let Some(i) = s.rfind('@') {
        s = s[i + 1..].to_string();
    }
    if let Some(i) = s.find(':') {
        s.truncate(i);
    }
    let s = s.trim_start_matches("*.").trim_start_matches('.').trim_end_matches('.');
    let s = s.strip_prefix("www.").unwrap_or(s);
    // Never block addresses of this computer: IP literals (127.0.0.1, the
    // app's own bridge), `*.localhost` (WebView2 serves OpenBlocker's window
    // from tauri.localhost) and `*.local` network names.
    let numeric = s.split('.').all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_digit()));
    if numeric || s == "localhost" || s.ends_with(".localhost") || s.ends_with(".local") {
        return None;
    }
    let valid = !s.is_empty()
        && s.len() <= 253
        && s.contains('.')
        && s.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    valid.then(|| s.to_string())
}

/// Like [`normalize_domain`], but keeps the path so parts of a website can be
/// blocked: `https://www.YouTube.com/Shorts/?x=1` → `youtube.com/shorts`.
/// Query, fragment and trailing slashes are dropped; without a path the result
/// is a plain domain.
pub fn normalize_site(input: &str) -> Option<String> {
    let s = input.trim().to_lowercase();
    let rest = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => &s[..],
    };
    let (host, path) = match rest.find('/') {
        // A '?' or '#' before the first '/' means there is no path.
        Some(i) if !rest[..i].contains(['?', '#']) => (&rest[..i], &rest[i..]),
        _ => (rest, ""),
    };
    let domain = normalize_domain(host)?;
    let path = path.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    if path.is_empty() {
        return Some(domain);
    }
    if path.chars().any(|c| c.is_whitespace() || c.is_control()) || path.contains("//") {
        return None;
    }
    Some(format!("{domain}{path}"))
}

/// `youtube.com/shorts` → `youtube.com`; plain domains are returned unchanged.
pub fn site_domain(site: &str) -> &str {
    site.split('/').next().unwrap_or(site)
}

/// Does this site entry only cover part of a website? Those can only be
/// enforced by the browser extension, never by the hosts file.
pub fn is_path_site(site: &str) -> bool {
    site.contains('/')
}

/// Does a URL fall under a site entry? `youtube.com` covers every page of
/// youtube.com and its subdomains; `youtube.com/shorts` covers that path and
/// everything below it.
pub fn url_matches(url: &str, site: &str) -> bool {
    let Some(page) = normalize_site(url) else { return false };
    let (host, path) = match page.find('/') {
        Some(i) => (&page[..i], &page[i..]),
        None => (&page[..], ""),
    };
    let domain = site_domain(site);
    if host != domain && !host.ends_with(&format!(".{domain}")) {
        return false;
    }
    match site.find('/') {
        None => true,
        Some(i) => {
            let prefix = &site[i..];
            path == prefix || path.starts_with(&format!("{prefix}/"))
        }
    }
}

/// Parses a community block list: hosts-file lines (`0.0.0.0 example.com`),
/// plain domain lists, and simple adblock rules (`||example.com^`). Comments,
/// local names and anything that isn't a domain are skipped.
pub fn parse_domain_list(text: &str) -> BTreeSet<String> {
    const LOCAL: [&str; 6] = ["localhost", "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-loopback"];
    let mut out = BTreeSet::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let first = parts.next().unwrap_or("");
        let names: Vec<&str> = if first.parse::<std::net::IpAddr>().is_ok() {
            parts.collect()
        } else if let Some(rule) = first.strip_prefix("||") {
            // Only plain domain rules; anything with a path or options is skipped.
            match rule.strip_suffix('^') {
                Some(d) if !d.contains(['/', '*', '$']) => vec![d],
                _ => vec![],
            }
        } else {
            vec![first]
        };
        for n in names {
            if LOCAL.contains(&n) || n.parse::<std::net::IpAddr>().is_ok() {
                continue;
            }
            if let Some(d) = normalize_domain(n) {
                out.insert(d);
            }
        }
    }
    out
}

/// Turns what people paste for a YouTube channel into one canonical form:
/// `@handle` (lowercase), a channel id `UC…` (22 more characters, case kept),
/// or a legacy `c/name` / `user/name`. Accepts full URLs
/// (`https://www.youtube.com/@Name/videos`), `@Name`, a bare handle, or an id.
/// Mirrored in `src/lib/util.ts` and `extension/common.js`.
pub fn normalize_channel(input: &str) -> Option<String> {
    let s = input.trim();
    let s = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let lower = s.to_ascii_lowercase();
    let host = ["www.youtube.com/", "m.youtube.com/", "youtube.com/", "music.youtube.com/"]
        .iter()
        .find(|p| lower.starts_with(*p));
    let was_url = host.is_some() || input.contains("://") || s.contains(['?', '#']);
    let s = host.map(|p| &s[p.len()..]).unwrap_or(s);
    let s = s.split(['?', '#']).next().unwrap_or("").trim_matches('/');
    let mut parts = s.split('/');
    let first = parts.next().unwrap_or("");
    let ok = |t: &str| !t.is_empty() && t.len() <= 100 && t.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    let is_id = |t: &str| t.len() == 24 && t.starts_with("UC") && ok(t);
    match first {
        "channel" => parts.next().filter(|id| is_id(id)).map(str::to_string),
        "c" | "user" => parts.next().filter(|n| ok(n)).map(|n| format!("{first}/{}", n.to_ascii_lowercase())),
        h if h.starts_with('@') && ok(&h[1..]) => Some(h.to_ascii_lowercase()),
        id if is_id(id) => Some(id.to_string()),
        // A bare name is taken as a handle, but not when it was a URL path.
        h if !was_url && !s.contains('/') && ok(h) && !h.contains('.') => Some(format!("@{}", h.to_ascii_lowercase())),
        _ => None,
    }
}

/// Host names written for one blocked domain.
pub fn expand_host(domain: &str, subdomains: bool) -> Vec<String> {
    let mut out = vec![domain.to_string()];
    if subdomains {
        for prefix in ["www.", "m.", "mobile."] {
            out.push(format!("{prefix}{domain}"));
        }
    }
    out
}

/// Host names per line. Windows reads at most 9; packing them keeps big
/// community lists from turning the hosts file into hundreds of thousands of lines.
const HOSTS_PER_LINE: usize = 9;

/// Renders our managed block (empty string when nothing is blocked).
/// Path entries (`youtube.com/shorts`) are skipped: the hosts file can only
/// block whole domains. `expand` decides which domains also get their
/// `www.`/`m.` variants (community lists usually contain those already).
pub fn render_section(domains: &BTreeSet<String>, subdomains: bool, expand: impl Fn(&str) -> bool, newline: &str) -> String {
    let hosts: Vec<String> = domains
        .iter()
        .filter(|d| !is_path_site(d))
        .flat_map(|d| expand_host(d, subdomains && expand(d)))
        .collect();
    if hosts.is_empty() {
        return String::new();
    }
    let mut s = String::new();
    s.push_str(BEGIN_MARKER);
    s.push_str(newline);
    for chunk in hosts.chunks(HOSTS_PER_LINE) {
        let names = chunk.join(" ");
        s.push_str(&format!("0.0.0.0 {names}{newline}:: {names}{newline}"));
    }
    s.push_str(END_MARKER);
    s.push_str(newline);
    s
}

/// Removes any previous managed section from `existing` and appends `section`.
pub fn merge(existing: &str, section: &str) -> String {
    if section.is_empty() && !existing.contains(BEGIN_MARKER) {
        // Nothing to add and nothing of ours to remove: leave the file untouched.
        return existing.to_string();
    }
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut kept: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in existing.lines() {
        let t = line.trim();
        if t == BEGIN_MARKER {
            inside = true;
            continue;
        }
        if t == END_MARKER {
            inside = false;
            continue;
        }
        if !inside {
            kept.push(line);
        }
    }
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join(newline);
    if !out.is_empty() {
        out.push_str(newline);
    }
    if !section.is_empty() {
        out.push_str(newline);
        out.push_str(section);
    }
    out
}

/// Newline style to use for a given existing hosts file.
pub fn newline_for(existing: &str) -> &'static str {
    if existing.contains("\r\n") || cfg!(windows) {
        "\r\n"
    } else {
        "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize_domain("https://www.YouTube.com/watch?v=1").as_deref(), Some("youtube.com"));
        assert_eq!(normalize_domain("*.reddit.com").as_deref(), Some("reddit.com"));
        assert_eq!(normalize_domain("news.ycombinator.com:443").as_deref(), Some("news.ycombinator.com"));
        assert_eq!(normalize_domain("localhost"), None);
        assert_eq!(normalize_domain("not a domain.com"), None);
        assert_eq!(normalize_domain(""), None);
    }

    #[test]
    fn normalizes_sites_with_paths() {
        assert_eq!(normalize_site("https://www.YouTube.com/Shorts/?x=1").as_deref(), Some("youtube.com/shorts"));
        assert_eq!(normalize_site("youtube.com/shorts/abc#t").as_deref(), Some("youtube.com/shorts/abc"));
        assert_eq!(normalize_site("reddit.com/").as_deref(), Some("reddit.com"));
        assert_eq!(normalize_site("reddit.com?x=/y").as_deref(), Some("reddit.com"));
        assert_eq!(normalize_site("user@x.com:8080/a").as_deref(), Some("x.com/a"));
        assert_eq!(normalize_site("x.com/a b"), None);
        assert_eq!(normalize_site("nope/path"), None);
        assert_eq!(site_domain("youtube.com/shorts"), "youtube.com");
    }

    #[test]
    fn paths_never_reach_the_hosts_file() {
        let domains: BTreeSet<String> = ["youtube.com/shorts".to_string()].into();
        assert_eq!(render_section(&domains, true, |_| true, "\n"), "");
        let domains: BTreeSet<String> = ["youtube.com/shorts".to_string(), "x.com".to_string()].into();
        let s = render_section(&domains, false, |_| true, "\n");
        assert!(s.contains("0.0.0.0 x.com") && !s.contains("youtube"));
    }

    #[test]
    fn merge_is_idempotent_and_preserves_user_lines() {
        let original = "127.0.0.1 localhost\n# my stuff\n10.0.0.1 nas\n";
        let domains: BTreeSet<String> = ["reddit.com".to_string()].into();
        let section = render_section(&domains, true, |_| true, "\n");
        let once = merge(original, &section);
        let twice = merge(&once, &section);
        assert_eq!(once, twice);
        assert!(once.starts_with("127.0.0.1 localhost\n# my stuff\n10.0.0.1 nas\n"));
        assert!(once.contains("0.0.0.0 reddit.com www.reddit.com m.reddit.com mobile.reddit.com"));
        // Removing everything restores the original.
        assert_eq!(merge(&once, ""), original);
    }

    #[test]
    fn untouched_when_nothing_to_do() {
        let original = "127.0.0.1 localhost\n\n\n";
        assert_eq!(merge(original, ""), original);
    }

    #[test]
    fn keeps_crlf() {
        let original = "127.0.0.1 localhost\r\n";
        let domains: BTreeSet<String> = ["x.com".to_string()].into();
        let merged = merge(original, &render_section(&domains, false, |_| true, newline_for(original)));
        assert!(!merged.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn packs_hosts_and_skips_expansion_when_asked() {
        let domains: BTreeSet<String> = (0..20).map(|i| format!("d{i}.com")).collect();
        let s = render_section(&domains, true, |d| d == "d0.com", "\n");
        // 20 domains + 3 variants of d0.com = 23 names -> 3 lines each for v4 and v6.
        assert_eq!(s.lines().filter(|l| l.starts_with("0.0.0.0 ")).count(), 3);
        assert!(s.contains("www.d0.com") && !s.contains("www.d1.com"));
    }

    #[test]
    fn url_matching() {
        assert!(url_matches("https://www.youtube.com/watch?v=1", "youtube.com"));
        assert!(url_matches("https://m.youtube.com/shorts/x", "youtube.com/shorts"));
        assert!(!url_matches("https://youtube.com/shortsx", "youtube.com/shorts"));
        assert!(!url_matches("https://notyoutube.com/", "youtube.com"));
        assert!(!url_matches("chrome://newtab", "youtube.com"));
    }

    #[test]
    fn parses_community_lists() {
        let text = "# comment\n127.0.0.1 localhost\n0.0.0.0 0.0.0.0\n0.0.0.0 ads.example.com tracker.example.org # x\n\
                    plain.example.net\n||adblock.example.com^\n||skip.example.com/path^\n! adblock comment\n::1 ip6-localhost\n";
        let got: Vec<String> = parse_domain_list(text).into_iter().collect();
        assert_eq!(got, ["adblock.example.com", "ads.example.com", "plain.example.net", "tracker.example.org"]);
    }

    #[test]
    fn normalizes_channels() {
        assert_eq!(normalize_channel("https://www.youtube.com/@Veritasium/videos").as_deref(), Some("@veritasium"));
        assert_eq!(normalize_channel("@3Blue1Brown").as_deref(), Some("@3blue1brown"));
        assert_eq!(normalize_channel("kurzgesagt").as_deref(), Some("@kurzgesagt"));
        assert_eq!(normalize_channel("youtube.com/channel/UCsXVk37bltHxD1rDPwtNM8Q").as_deref(), Some("UCsXVk37bltHxD1rDPwtNM8Q"));
        assert_eq!(normalize_channel("UCsXVk37bltHxD1rDPwtNM8Q").as_deref(), Some("UCsXVk37bltHxD1rDPwtNM8Q"));
        assert_eq!(normalize_channel("https://m.youtube.com/c/SomeName").as_deref(), Some("c/somename"));
        assert_eq!(normalize_channel("https://youtube.com/user/Old?x=1").as_deref(), Some("user/old"));
        assert_eq!(normalize_channel("https://youtube.com/watch?v=abc"), None);
        assert_eq!(normalize_channel("example.com"), None);
        assert_eq!(normalize_channel(""), None);
    }

    #[test]
    fn local_addresses_are_never_blocked() {
        for d in ["127.0.0.1", "http://127.0.0.1:47613/v1/rules", "tauri.localhost", "ipc.localhost", "localhost", "nas.local", "192.168.1.1"] {
            assert_eq!(normalize_domain(d), None, "{d}");
            assert_eq!(normalize_site(d), None, "{d}");
        }
        assert_eq!(normalize_domain("1password.com").as_deref(), Some("1password.com"));
        assert!(parse_domain_list("0.0.0.0 tauri.localhost\n0.0.0.0 127.0.0.1\n").is_empty());
    }
}
