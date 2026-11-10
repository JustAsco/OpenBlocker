# OpenBlocker

**A modern, free and open-source distraction blocker for your PC.**
Block websites and apps on a schedule, run Pomodoro focus sessions, or freeze your whole computer, with no subscription and no license key.

> Status: early MVP (v0.1). Windows first. Linux/macOS are planned (the core is already cross-platform).

## Features

| | |
|---|---|
| 🏷️ **Categories** | Reusable, editable groups of sites and apps (Social media, Adult, Gambling, …). Ten built-in ones you can customise or restore, plus your own. Edit a category once and every block list using it updates. Import a maintained community list (e.g. ~77,000 adult sites) into any category with one click. |
| 🧱 **Block lists** | What gets blocked together: tick the categories to include and add your own extras. Smart autosuggest: type `you` → YouTube (+ youtu.be, ytimg.com), paste any URL and it's normalised, pick installed/running apps with their real icons. Block just part of a site, like `youtube.com/shorts` (needs the extension). |
| ⚡ **Quick block** | Block a list right now for 25 min, 1 h, the rest of the day, or any custom duration. |
| 📅 **Weekly schedule** | A real calendar: drag to create a block, click to edit, overnight blocks (22:00 → 07:00), templates (work hours, bedtime, weekend detox), hours-per-week summary. |
| ⏳ **Daily limits** | "At most 30 minutes of YouTube a day": time counts while one of a list's apps or websites is in front and you're active; once it's used up, the list is blocked until midnight. Optionally locked. |
| 🍅 **Focus timer** | Pomodoro with presets (25/5, 50/10, 90/20…), automatically blocks a list during focus rounds, optional auto-stop after N rounds. |
| ❄️ **Freeze PC** | Full-screen lock on every monitor for a set time, with your own message. Task Manager is blocked while frozen. |
| 🧩 **Browser extension** | Optional, works alongside the hosts file. Blocks instantly, including tabs that are already open, shows a friendly block page, and sends you back to the site when the block ends. OpenBlocker suggests it when a website block starts without it (can be turned off). Chrome, Edge, Brave, Opera, Vivaldi, Firefox. |
| ✅ **Allowlists** | Switch any list to "allow only these websites": in browsers everything else is blocked (needs the extension; browsers without it are closed while the allowlist runs). |
| 🔒 **Strictness levels** | *Flexible* (stop any time) · *Type to unlock* (type a long random text, paste disabled) · *Locked* (cannot be stopped). Locked lists can only grow, never shrink. Locked schedules can't be edited while running. Starting anything locked shows a warning you have to hold to confirm, with an extra alert for never-ending schedules. |
| 💾 **Backup** | Export your lists, categories, schedules and settings to a file and import them on another PC. |
| 📊 **Stats** | Focus time, pomodoros and blocked app launches per day, weekly chart and streaks. |
| 🛡️ **Robust** | A background service keeps blocking while the app is closed or killed, restarts the app during locks, and can't be stopped while something is locked. Uninstalling or updating is refused during a lock, and settings that would loosen blocking are locked too. No administrator prompt for the app. |

Everything stays on your machine. The only network requests are website icons (Google favicon service, can be turned off in Settings) and community lists, which are downloaded from GitHub only when you import or update one.

## How blocking works

- **Background service:** the installer registers `openblocker.exe --service` as the Windows service “OpenBlocker” (runs as SYSTEM, restarts automatically if it crashes or is killed). It does everything that needs administrator rights and keeps working while the app is closed. The app sends it every change; the service keeps its own copy in `C:\ProgramData\OpenBlocker` (only SYSTEM and administrators can change it) and refuses any change that would weaken a running lock, so neither killing the app nor editing its data files gets around a lock. While something is locked the service doesn't accept “stop”, and it restarts the app if it was killed (the app shows the freeze screen and notifications). Without the service (e.g. in development) the app enforces by itself and needs administrator rights for websites.
- **Websites:** a clearly marked section in the system `hosts` file (`C:\Windows\System32\drivers\etc\hosts`) points blocked domains to `0.0.0.0`, then the DNS cache is flushed. Nothing outside that section is touched, and it's removed when nothing is blocked. Up to nine names share a line, so even large community lists keep the file manageable.
- **Browser extension** (`extension/`, optional): runs alongside the hosts file. It polls the service (or the app) on `127.0.0.1:47613` every 2 s and enforces the rules with `declarativeNetRequest`, including path rules like `youtube.com/shorts` that the hosts file can't express. When rules change it redirects open tabs that are now blocked. Unchanged rules aren't resent, so big lists stay cheap. For daily limits it reports the address of the active tab while the browser window has focus and you aren't idle; nothing else about your browsing is sent, and only to OpenBlocker on your own computer. The bridge only listens on localhost, checks the `Host` header, sends no CORS headers and requires a custom header, so websites can't read your lists. On Windows the calling browser is identified from the TCP connection's owning process. Optionally (always, for allowlists), browsers in which the extension isn't running are closed.
- **Apps:** a background loop checks running processes once per second and closes any blocked executable (`steam.exe`, …).
- **Daily limits:** the app checks once per second which program has the foreground window (and, for browsers, which tab is active) and whether you've touched the keyboard or mouse in the last minute.
- **Freeze:** always-on-top, full-screen, undecorated windows cover every monitor until the timer ends.

## Locked yourself out?

If you made a lock you can't live with (say, a locked schedule that runs 24/7), there's a hidden **emergency reset**: go to **Settings → About** and click the version number (“OpenBlocker 0.1.0”) seven times. It resets OpenBlocker to a fresh install, ending every block, schedule, lock and setting. Statistics are kept, and your old data is saved as `state.before-reset.json` in the app's data folder (`%APPDATA%\org.openblocker.app\` on Windows). While something is locked you first have to type a long random text (handed out and checked by the background service), so it isn't a quick way out.

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

To try the background service without installing it, run `openblocker --service-console` from an administrator terminal (set `OPENBLOCKER_SERVICE_DIR` to keep its data somewhere other than ProgramData). The app connects to it automatically. The installer hooks that register the service are in `src-tauri/windows/hooks.nsh`.

GitHub Actions builds the Windows installer (NSIS `.exe`) on every push to `main` and publishes a draft release for `v*` tags. There's no `.msi` any more: only the NSIS installer can register the service and refuse to uninstall during a lock.

### Project layout

```
src/                     React + TypeScript + Tailwind UI
  pages/                 Today, Block lists, Categories, Schedule, Daily limits, Focus, Freeze, Settings
  lib/api.ts             Tauri command bindings (falls back to lib/mock.ts in a browser)
  lib/catalog.ts         Autosuggest helpers over the shared built-in catalog
src-tauri/
  core/                  Pure Rust: data model, schedules, limits, lock rules, hosts rendering, list parsing (unit-tested)
  core/catalog.json      Built-in categories, shared by Rust and the UI
  src/lib.rs             Tauri commands, main loop (timers, usage, syncing with the service), tray, freeze windows
  src/service.rs         Background Windows service: protected state, lock checks, watchdog, API for the app
  src/enforce.rs         Hosts file, closing apps/browsers, extension rules (used by the service or the app)
  src/bridge.rs          Local HTTP bridge for the browser extension
  src/platform.rs        OS integration: hosts file, processes, icons, foreground window, autostart
  windows/hooks.nsh      Installer hooks: register the service, refuse to uninstall during a lock
```

## Roadmap

- [x] Browser extension with block page and open-tab enforcement
- [x] Extension: path-level blocking (`youtube.com/shorts`)
- [ ] Extension: store/AMO publishing, incognito enforcement
- [x] **Background Windows service + watchdog**: blocks survive killing the app, no admin prompt for the UI
- [x] Uninstall/settings protection during locked blocks
- [x] Allowlist mode for websites
- [ ] Allowlist mode for apps
- [x] Usage limits ("max 30 min of YouTube per day")
- [x] Importable community category lists (large adult/gambling/news domain lists)
- [ ] Linux and macOS support (hosts + process blocking already implemented cross-platform in `core`)
- [ ] Light theme, i18n
- [x] Export/import settings
- [x] Warning before starting a locked block, hidden emergency reset
- [ ] **User accounts**: sign in to sync lists, categories, schedules and settings between devices (optional; everything keeps working offline and without an account)

Contributions are very welcome. Open an issue to discuss bigger changes.

## Known limitations

- Without the extension, hosts-file blocking only affects new connections: already-open tabs can keep working for a while. Install the extension for instant, reliable blocking.
- Parts of websites (`youtube.com/shorts`) can only be blocked by the extension; in browsers without it they stay reachable.
- The extension is loaded unpacked (Developer mode) for now; Firefox only keeps it until restart until it's published on AMO. Incognito windows are covered only if you allow the extension in incognito.
- An administrator who is determined enough can still get around it (e.g. disable the service and reboot). The service makes it much harder, not impossible.
- Daily limits are counted by the app, so time only counts while it runs (it starts with Windows if you enable that, and the service restarts it during locks). Websites only count in browsers with the extension.
- The service keeps one shared copy of the blocks, so OpenBlocker assumes one Windows user per PC for now.
- Some antivirus tools warn about hosts-file changes. OpenBlocker only edits its own marked section.

## License

[AGPL-3.0](LICENSE)
