# Contributing to OpenBlocker

Contributions, bug reports, and ideas are very welcome!

## Before starting big changes

Please open an issue first to discuss bigger features or architectural changes so we can align on design, strictness guarantees, and security boundaries (see [SECURITY.md](SECURITY.md)).

## Contributor License Agreement (CLA)

By submitting a pull request to this repository, you agree to the [OpenBlocker Contributor License Agreement](CLA.md). You keep the copyright to your code, while granting the project maintainer the right to distribute and relicense it as part of OpenBlocker.

## Local checks before opening a PR

Run the relevant checks from the repository root:

```bash
# Pure Rust core unit tests (schedules, limits, lock rules, hosts rendering)
cd src-tauri && cargo test -p openblocker-core

# Background service local API security & behaviour tests
python3 dev/service_api_test.py

# Frontend TypeScript check & production bundle
npm run build

# Browser extension tests
node dev/extension_test.cjs
```

From Linux/WSL, you can also run `dev/check-windows.sh` to type-check and lint the Windows Rust build.

