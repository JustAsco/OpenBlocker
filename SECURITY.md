# Security

OpenBlocker runs a Windows service as SYSTEM and can close programs and edit
the hosts file. This document describes what it protects against, how, and
how that's tested. Please report security problems privately through GitHub's
"Report a vulnerability" (Security tab) rather than in a public issue.

## What we protect against

1. **Web pages** must not be able to read your lists or change anything.
2. **Other programs on the PC** (without administrator rights) must not be
   able to use OpenBlocker to harm the system, e.g. by making the SYSTEM
   service close Windows processes.
3. **You, in a weak moment**, must not be able to get around a lock you
   chose: not by closing or killing the app, editing its files, uninstalling
   it or loosening settings.
4. **Nothing may lock you out for good.** Whatever the configuration, the
   app stays usable and the emergency reset stays reachable.

An administrator who is determined enough (disabling the service and
rebooting, editing ProgramData) can still get around a lock. That's out of
scope: the goal is friction, not a prison.

## How

**Local HTTP endpoints** (`127.0.0.1:47613` for the extension, `47614` for
the app; `src-tauri/src/http.rs`)
- listen on the loopback address only;
- require a custom header (`X-OpenBlocker`, `X-OpenBlocker-Service`), which a
  web page can't send without a CORS preflight that is never approved;
- check the `Host` header against `127.0.0.1`/`localhost`, which defeats DNS
  rebinding;
- refuse requests carrying a web page's `Origin`;
- send no CORS headers, so pages can't read responses;
- cap request bodies at 32 MB; ids used in file names are restricted to
  `[A-Za-z0-9_-]`.

**What the service will do** (`src-tauri/src/platform.rs`, `engine.rs`)
- It never closes a protected program, whatever a list or a community list
  says: Windows processes (`csrss.exe`, `winlogon.exe`, `dwm.exe`,
  `explorer.exe`, `svchost.exe`, …), WebView2 (`msedgewebview2.exe`, which
  draws OpenBlocker's window) and OpenBlocker itself, even when renamed. See
  `PROTECTED_EXES`.
- It only closes processes in a user's desktop session, never in session 0
  (services).
- It never blocks addresses of this computer: IP literals, `*.localhost`
  (WebView2 serves the app from `tauri.localhost`) and `*.local`.
- Hosts-file entries are normalised domains only, so nothing can be injected
  into the file.

**Locks** (`engine::lock_violation`, `service.rs`)
- One rule decides whether a change weakens a running lock; the app and the
  service both apply it. The service keeps its own copy of the state in
  `C:\ProgramData\OpenBlocker` (writable by SYSTEM and administrators only)
  and refuses weakening updates, so editing the app's data file doesn't help.
- A generation counter stops an outdated state from bringing back a block
  that was just ended with its unlock text or password.
- While something is locked, the service doesn't accept "stop", restarts the
  app if it was killed, and the installer refuses to update or uninstall.
- Typed unlock texts and the emergency-reset text are generated and checked
  by the service.
- The unlock password is stored as an Argon2id hash; after a wrong guess,
  further attempts are refused for 3 seconds. It can only be changed or
  removed with the current password (or by the emergency reset).

**Never locked out**
- The app's window, its tray icon and the processes they need are protected
  (see above), and allowlists or closed browsers don't affect them.
- The emergency reset (7 clicks on the version in Settings → About, or on
  "Unlocks at" on the freeze screen) works in every configuration. While
  something is locked it asks for a long typed text.

## Tests

- `cargo test -p openblocker-core` (in `src-tauri/`): lock rules, protected
  programs, local addresses, list parsing, schedules, limits.
- `cargo test` in `src-tauri/` on Windows also runs the password and HTTP
  helper tests.
- `python3 dev/service_api_test.py`: builds the real service code without
  Tauri (`dev/service-harness`) and attacks its API over HTTP: missing or
  forged headers, DNS rebinding, web origins, oversized bodies, malformed
  state, path traversal, weakening a lock, stale states, wrong unlock texts,
  password guessing, tampering with the password, and the emergency reset.
- Both run in CI on every pull request.

## Known gaps

- Any local program can *add* blocks through the service API (it can't
  remove or weaken them). That's a nuisance, not a privilege escalation.
- The app's web view has no Content Security Policy yet. It only shows
  local content, but a CSP would be an extra layer.
- Daily limits are counted by the app; killing it (outside a lock) stops the
  counting.
