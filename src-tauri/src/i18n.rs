//! Texts the app shows itself: notifications and the tray menu. The UI has
//! its own translations (src/locales/); like there, the English text is the
//! key and anything not translated stays English.

/// The language to use: the setting, or Windows' language when it's empty.
pub fn language(setting: &str) -> &'static str {
    let code = if setting.is_empty() { system_language() } else { setting.to_string() };
    match code.get(..2).map(str::to_ascii_lowercase).as_deref() {
        Some("de") => "de",
        _ => "en",
    }
}

fn system_language() -> String {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Globalization::GetUserDefaultLocaleName;
        let mut buf = [0u16; 85];
        let n = GetUserDefaultLocaleName(&mut buf);
        if n > 1 {
            return String::from_utf16_lossy(&buf[..n as usize - 1]);
        }
        String::new()
    }
    #[cfg(not(windows))]
    {
        std::env::var("LANG").unwrap_or_default()
    }
}

/// Translates `en` and fills in `{name}` placeholders.
pub fn tr(lang: &str, en: &str, args: &[(&str, &str)]) -> String {
    let mut out = match lang {
        "de" => german(en).unwrap_or(en),
        _ => en,
    }
    .to_string();
    for (k, v) in args {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

fn german(en: &str) -> Option<&'static str> {
    Some(match en {
        "Open OpenBlocker" => "OpenBlocker öffnen",
        "Quit" => "Beenden",
        "Block finished" => "Sperre beendet",
        "“{name}” is unblocked again." => "„{name}“ ist wieder freigegeben.",
        "Back to focus 🎯" => "Zurück zum Fokus 🎯",
        "Round {round} has started." => "Runde {round} hat begonnen.",
        "Short break ☕" => "Kurze Pause ☕",
        "Stand up, stretch, drink water." => "Steh auf, streck dich, trink Wasser.",
        "Long break 🌿" => "Lange Pause 🌿",
        "Great work! Take a proper rest." => "Gute Arbeit! Gönn dir eine richtige Pause.",
        "Pomodoro complete 🎉" => "Pomodoro abgeschlossen 🎉",
        "All rounds done. Nicely focused!" => "Alle Runden geschafft. Schön fokussiert!",
        "Freeze ended" => "Einfrieren beendet",
        "Your computer is unlocked." => "Dein Computer ist entsperrt.",
        "Daily limit reached ⏳" => "Tageslimit erreicht ⏳",
        "“{name}” is blocked until midnight." => "„{name}“ ist bis Mitternacht gesperrt.",
        "5 minutes left ⏳" => "Noch 5 Minuten ⏳",
        "Your daily time for “{name}” is almost up." => "Deine Tageszeit für „{name}“ ist fast aufgebraucht.",
        "Blocked 🚫" => "Gesperrt 🚫",
        "{apps} was closed." => "{apps} wurde geschlossen.",
        "Browser closed 🧩" => "Browser geschlossen 🧩",
        "{browsers} doesn't have the OpenBlocker extension running." => "In {browsers} läuft die OpenBlocker-Erweiterung nicht.",
        "{browsers}: the OpenBlocker extension isn't allowed in private windows. Turn on “Allow in Incognito” in its details." => {
            "{browsers}: Die OpenBlocker-Erweiterung ist in privaten Fenstern nicht erlaubt. Aktiviere „Im Inkognitomodus zulassen“ in ihren Details."
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_and_fills_in() {
        assert_eq!(tr("de", "Round {round} has started.", &[("round", "3")]), "Runde 3 hat begonnen.");
        assert_eq!(tr("en", "Round {round} has started.", &[("round", "3")]), "Round 3 has started.");
        assert_eq!(tr("de", "Not translated", &[]), "Not translated");
        assert_eq!(language("de-AT"), "de");
        assert_eq!(language("fr"), "en");
    }
}
