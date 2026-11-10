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

/// Host names written for one blocked domain.
pub fn expand(domain: &str, subdomains: bool) -> Vec<String> {
    let mut out = vec![domain.to_string()];
    if subdomains {
        for prefix in ["www.", "m.", "mobile."] {
            out.push(format!("{prefix}{domain}"));
        }
    }
    out
}

/// Renders our managed block (empty string when nothing is blocked).
pub fn render_section(domains: &BTreeSet<String>, subdomains: bool, newline: &str) -> String {
    if domains.is_empty() {
        return String::new();
    }
    let mut s = String::new();
    s.push_str(BEGIN_MARKER);
    s.push_str(newline);
    for d in domains {
        for host in expand(d, subdomains) {
            s.push_str(&format!("0.0.0.0 {host}{newline}:: {host}{newline}"));
        }
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
    fn merge_is_idempotent_and_preserves_user_lines() {
        let original = "127.0.0.1 localhost\n# my stuff\n10.0.0.1 nas\n";
        let domains: BTreeSet<String> = ["reddit.com".to_string()].into();
        let section = render_section(&domains, true, "\n");
        let once = merge(original, &section);
        let twice = merge(&once, &section);
        assert_eq!(once, twice);
        assert!(once.starts_with("127.0.0.1 localhost\n# my stuff\n10.0.0.1 nas\n"));
        assert!(once.contains("0.0.0.0 www.reddit.com"));
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
        let merged = merge(original, &render_section(&domains, false, newline_for(original)));
        assert!(!merged.replace("\r\n", "").contains('\n'));
    }
}
