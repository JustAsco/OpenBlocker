#!/bin/sh
# Type-checks and lints the Windows app from Linux/WSL without a Windows
# toolchain: only `cargo check`/`clippy`, nothing is linked.
#
# tauri-winres needs a resource compiler (llvm-rc) even for checks; a stub
# that writes empty outputs is enough because nothing gets linked.
set -e
cd "$(dirname "$0")/../src-tauri"
rustup target add x86_64-pc-windows-msvc >/dev/null 2>&1 || true
stub="$(mktemp -d)"
cat > "$stub/llvm-rc" <<'STUB'
#!/bin/sh
prev=""
for a in "$@"; do
  case "$prev" in /fo|-fo|/FO|-FO) : > "$a";; esac
  prev="$a"
done
exit 0
STUB
chmod +x "$stub/llvm-rc"
PATH="$stub:$PATH" cargo clippy --target x86_64-pc-windows-msvc -p openblocker "$@"
rm -rf "$stub"
