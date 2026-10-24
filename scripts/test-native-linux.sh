#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/payload/scripts" "$WORK_DIR/deb" "$WORK_DIR/rpm"
printf 'console.log("native-package-smoke");\n' > "$WORK_DIR/payload/scripts/jarela-bin.mjs"
bash "$REPO_ROOT/scripts/package-native-linux.sh" "$WORK_DIR/payload" 0.0.0 "$WORK_DIR/out"

deb="$WORK_DIR/out/jarela-0.0.0-linux.deb"
rpm="$WORK_DIR/out/jarela-0.0.0-linux.rpm"
test "$(dpkg-deb -f "$deb" Package)" = jarela
test "$(dpkg-deb -f "$deb" Version)" = 0.0.0
test "$(dpkg-deb -f "$deb" Architecture)" = "$(dpkg --print-architecture)"
test "$(rpm -qp --queryformat '%{NAME} %{VERSION} %{ARCH}' "$rpm")" = "jarela 0.0.0 x86_64"

dpkg-deb -x "$deb" "$WORK_DIR/deb"
rpm2cpio "$rpm" | (cd "$WORK_DIR/rpm" && cpio -idm --quiet)
for format in deb rpm; do
  root="$WORK_DIR/$format"
  cmp "$(command -v node)" "$root/usr/lib/jarela/runtime/node"
  cmp "$WORK_DIR/payload/scripts/jarela-bin.mjs" "$root/usr/lib/jarela/scripts/jarela-bin.mjs"
  test -x "$root/usr/bin/jarela"
  test "$("$root/usr/lib/jarela/runtime/node" "$root/usr/lib/jarela/scripts/jarela-bin.mjs")" = native-package-smoke
done
echo "Native Linux package smoke test passed: DEB and RPM metadata, payloads, and runtime verified."
