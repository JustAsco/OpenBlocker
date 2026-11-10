# OpenBlocker

**A modern, free and open-source distraction blocker for your PC.**
Block websites and apps on a schedule, run Pomodoro focus sessions, or freeze your whole computer, with no subscription and no license key.

> Status: early MVP (v0.1). Windows first. Linux/macOS are planned (the core is already cross-platform).

## Features

| | |
|---|---|
| 🏷️ **Categories** | Reusable, editable groups of sites and apps (Social media, Adult, Gambling, …). Ten built-in ones you can customise or restore, plus your own. Edit a category once and every block list using it updates. |
| 🧱 **Block lists** | What gets blocked together: tick the categories to include and add your own extras. Smart autosuggest: type `you` → YouTube (+ youtu.be, ytimg.com), paste any URL and it's normalised, pick installed/running apps with their real icons. |
| ⚡ **Quick block** | Block a list right now for 25 min, 1 h, the rest of the day, or any custom duration. |
| 📅 **Weekly schedule** | A real calendar: drag to create a block, click to edit, overnight blocks (22:00 → 07:00), templates (work hours, bedtime, weekend detox), hours-per-week summary. |
| 🍅 **Focus timer** | Pomodoro with presets (25/5, 50/10, 90/20…), automatically blocks a list during focus rounds, optional auto-stop after N rounds. |
| ❄️ **Freeze PC** | Full-screen lock on every monitor for a set time, with your own message. Task Manager is blocked while frozen. |
| 🧩 **Browser extension** | Blocks instantly, including tabs that are already open, shows a friendly block page, and sends you back to the site when the block ends. Chrome, Edge, Brave, Opera, Vivaldi, Firefox. |
| ✅ **Allowlists** | Switch any list to "allow only these websites": in browsers everything else is blocked (needs the extension; browsers without it are closed while the allowlist runs). |
| 🔒 **Strictness levels** | *Flexible* (stop any time) · *Type to unlock* (type a long random text, paste disabled) · *Locked* (cannot be stopped). Locked lists can only grow, never shrink. Locked schedules can't be edited while running. |
| 📊 **Stats** | Focus time, pomodoros and blocked app launches per day, weekly chart and streaks. |
| 🛡️ **Robust** | State persists across restarts, closes to the tray, optional start-with-Windows (elevated scheduled task), refuses to quit while a locked block runs. |

Everything stays on your machine. The only network request is for website icons (Google favicon service), which can be turned off in Settings.

## How blocking works

- **Websites:** OpenBlocker writes a clearly marked section to the system `hosts` file (`C:\Windows\System32\drivers\etc\hosts`) that points blocked domains to `0.0.0.0`, then flushes the DNS cache. Nothing outside its own section is touched, and the section is removed when nothing is blocked. This works in every browser and app but **needs administrator rights**, so the installed app always starts as administrator (one UAC prompt, or none when started by the "Start with Windows" task).
- **Browser extension** (`extension/`): polls the app on `127.0.0.1:47613` every 2 s and enforces the rules with `declarativeNetRequest`. When rules change it redirects open tabs that are now blocked. The bridge only listens on localhost, sends no CORS headers and requires a custom header, so websites can't read your lists. On Windows the calling browser is identified from the TCP connection's owning process. Optionally (always, for allowlists), browsers in which the extension isn't running are closed.
- **Apps:** a background loop checks running processes once per second and closes any blocked executable (`steam.exe`, …).
- **Freeze:** always-on-top, full-screen, undecorated windows cover every monitor until the timer ends.

## Development

Requirements: [Node.js 20+](https://nodejs.org), [Rust](https://rustup.rs), and on Windows the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (WebView2 + MSVC build tools).

```bash
npm install
npm run tauri dev        # run the desktop app (dev builds don't self-elevate: use an admin terminal
                         # or the in-app "Restart as administrator" button for website blocking)
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
  lib/catalog.ts         Autosuggest helpers over the shared built-in catalog
src-tauri/
  core/                  Pure Rust: data model, schedule/pomodoro engine, hosts rendering (unit-tested)
  core/catalog.json      Built-in categories, shared by Rust and the UI
  src/lib.rs             Tauri commands, enforcement loop, tray, freeze windows
  src/platform.rs        OS integration: hosts file, processes, icons, elevation, autostart
```

## Roadmap

- [x] Browser extension with block page and open-tab enforcement
- [ ] Extension: path-level blocking (`youtube.com/shorts`), store/AMO publishing, incognito enforcement
- [ ] **Background Windows service + watchdog**: blocks survive killing the app, no admin prompt for the UI
- [ ] Uninstall/settings protection during locked blocks
- [x] Allowlist mode for websites
- [ ] Allowlist mode for apps
- [ ] Usage limits ("max 30 min of YouTube per day")
- [ ] Importable community category lists (large adult/gambling/news domain lists)
- [ ] Linux and macOS support (hosts + process blocking already implemented cross-platform in `core`)
- [ ] Light theme, i18n
- [ ] Export/import settings

Contributions are very welcome. Open an issue to discuss bigger changes.

## Known limitations

- Without the extension, hosts-file blocking only affects new connections: already-open tabs can keep working for a while. Install the extension for instant, reliable blocking.
- The extension is loaded unpacked (Developer mode) for now; Firefox only keeps it until restart until it's published on AMO. Incognito windows are covered only if you allow the extension in incognito.
- Someone with admin rights who is determined enough can bypass it (e.g. by killing the process from an elevated shell). The planned service + watchdog will make this much harder.
- Some antivirus tools warn about hosts-file changes. OpenBlocker only edits its own marked section.

## License

[AGPL-3.0](LICENSE)
