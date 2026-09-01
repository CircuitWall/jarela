#!/usr/bin/env bash
# Build a native macOS pkg from a staged Jarela release payload.

set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <staged-dir> <version> [out-dir]" >&2
  exit 2
fi

STAGED_DIR="$1"
VERSION="$2"
OUT_DIR="${3:-dist}"

[[ -d "$STAGED_DIR" ]] || { echo "staged dir not found: $STAGED_DIR" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }
command -v pkgbuild >/dev/null || { echo "pkgbuild not found on PATH" >&2; exit 1; }

STAGED_DIR="$(cd "$STAGED_DIR" && pwd)"
OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PKGROOT="$WORK_DIR/pkgroot"
APP_DIR="$PKGROOT/Applications/Jarela"
BIN_DIR="$PKGROOT/usr/local/bin"
NODE_BIN="$(command -v node)"

mkdir -p "$APP_DIR/runtime" "$BIN_DIR"
cp -R "$STAGED_DIR/." "$APP_DIR/"
cp "$NODE_BIN" "$APP_DIR/runtime/node"
chmod 755 "$APP_DIR/runtime/node"

cat > "$BIN_DIR/jarela" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec /Applications/Jarela/runtime/node /Applications/Jarela/scripts/jarela-bin.mjs "$@"
SH
chmod 755 "$BIN_DIR/jarela"

pkgbuild \
  --root "$PKGROOT" \
  --identifier "com.circuitwall.jarela" \
  --version "$VERSION" \
  --install-location / \
  "$OUT_DIR/jarela-${VERSION}-darwin.pkg"

echo "native macOS package written to $OUT_DIR/jarela-${VERSION}-darwin.pkg"