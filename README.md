# OpenBlocker

**A modern, free and open-source distraction blocker for your PC.**
Block websites and apps on a schedule, run Pomodoro focus sessions, or freeze your whole computer, with no subscription and no license key.

> Status: early MVP (v0.1). Windows first. Linux/macOS are planned (the core is already cross-platform).

## Features

| | |
|---|---|
| 🧱 **Block lists** | Group websites and apps ("Social media", "Games", …). Smart autosuggest: type `you` → YouTube (+ youtu.be, ytimg.com), paste any URL and it's normalised, add whole categories in one click, pick installed/running apps with their real icons. |
| ⚡ **Quick block** | Block a list right now for 25 min, 1 h, the rest of the day, or any custom duration. |
| 📅 **Weekly schedule** | A real calendar: drag to create a block, click to edit, overnight blocks (22:00 → 07:00), templates (work hours, bedtime, weekend detox), hours-per-week summary. |
| 🍅 **Focus timer** | Pomodoro with presets (25/5, 50/10, 90/20…), automatically blocks a list during focus rounds, optional auto-stop after N rounds. |
| ❄️ **Freeze PC** | Full-screen lock on every monitor for a set time, with your own message. Task Manager is blocked while frozen. |
| 🔒 **Strictness levels** | *Flexible* (stop any time) · *Type to unlock* (type a long random text, paste disabled) · *Locked* (cannot be stopped). Locked lists can only grow, never shrink. Locked schedules can't be edited while running. |
| 📊 **Stats** | Focus time, pomodoros and blocked app launches per day, weekly chart and streaks. |
| 🛡️ **Robust** | State persists across restarts, closes to the tray, optional start-with-Windows (elevated scheduled task), refuses to quit while a locked block runs. |

Everything stays on your machine. The only network request is for website icons (Google favicon service), which can be turned off in Settings.

## How blocking works

- **Websites:** OpenBlocker writes a clearly marked section to the system `hosts` file (`C:\Windows\System32\drivers\etc\hosts`) that points blocked domains to `0.0.0.0`, then flushes the DNS cache. Nothing outside its own section is touched, and the section is removed when nothing is blocked. This works in every browser and app but **needs administrator rights**; the app shows a "Restart as administrator" button if it doesn't have them.
- **Apps:** a background loop checks running processes once per second and closes any blocked executable (`steam.exe`, …).
- **Freeze:** always-on-top, full-screen, undecorated windows cover every monitor until the timer ends.

## Development

Requirements: [Node.js 20+](https://nodejs.org), [Rust](https://rustup.rs), and on Windows the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (WebView2 + MSVC build tools).

```bash
npm install
npm run tauri dev        # run the desktop app (run your terminal as admin for website blocking)
npm run tauri build      # build the installer (src-tauri/target/release/bundle)
```

UI-only development works in any browser, with a mock backend that blocks nothing:

```bash
npm run dev              # http://localhost:1420
```

Core logic tests (schedules, pomodoro, lock rules, hosts rendering) run on any OS:

```bash
cd src-tauri && cargo test -p openblocker-core
```

GitHub Actions builds the Windows installer (`.exe` + `.msi`) on every push to `main` and publishes a draft release for `v*` tags.

### Project layout

```
src/                     React + TypeScript + Tailwind UI
  pages/                 Today, Block lists, Schedule, Focus, Freeze, Settings
  lib/api.ts             Tauri command bindings (falls back to lib/mock.ts in a browser)
  lib/catalog.ts         Built-in site/app knowledge for autosuggest
src-tauri/
  core/                  Pure Rust: data model, schedule/pomodoro engine, hosts rendering (unit-tested)
  src/lib.rs             Tauri commands, enforcement loop, tray, freeze windows
  src/platform.rs        OS integration: hosts file, processes, icons, elevation, autostart
```

## Roadmap

- [ ] **Browser extension**: path-level blocking (`youtube.com/shorts`), a friendly block page, incognito coverage
- [ ] **Background Windows service + watchdog**: blocks survive killing the app, no admin prompt for the UI
- [ ] Uninstall/settings protection during locked blocks
- [ ] Allow-list mode ("block everything except …") for websites and apps
- [ ] Usage limits ("max 30 min of YouTube per day")
- [ ] Importable community block lists (adult, gambling, news …)
- [ ] Linux and macOS support (hosts + process blocking already implemented cross-platform in `core`)
- [ ] Light theme, i18n
- [ ] Export/import settings

Contributions are very welcome. Open an issue to discuss bigger changes.

## Known limitations

- Hosts-file blocking is domain-level. Already-open connections may keep working until the tab is reloaded or the browser restarted.
- Someone with admin rights who is determined enough can bypass it (e.g. by killing the process from an elevated shell). The planned service + watchdog will make this much harder.
- Some antivirus tools warn about hosts-file changes. OpenBlocker only edits its own marked section.

## License

[AGPL-3.0](LICENSE)
