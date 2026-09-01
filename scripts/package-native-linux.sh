#!/usr/bin/env bash
# Build native Linux packages from a staged Jarela release payload.

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
command -v dpkg-deb >/dev/null || { echo "dpkg-deb not found on PATH" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGED_DIR="$(cd "$STAGED_DIR" && pwd)"
OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

APP_DIR="usr/lib/jarela"
BIN_DIR="usr/bin"
PACKAGE_BASENAME="jarela-${VERSION}-linux"
NODE_BIN="$(command -v node)"

copy_payload() {
  local root="$1"
  mkdir -p "$root/$APP_DIR" "$root/$BIN_DIR" "$root/$APP_DIR/runtime"
  cp -R "$STAGED_DIR/." "$root/$APP_DIR/"
  cp "$NODE_BIN" "$root/$APP_DIR/runtime/node"
  chmod 755 "$root/$APP_DIR/runtime/node"
  cat > "$root/$BIN_DIR/jarela" <<'SH'
#!/usr/bin/env sh
set -eu
exec /usr/lib/jarela/runtime/node /usr/lib/jarela/scripts/jarela-bin.mjs "$@"
SH
  chmod 755 "$root/$BIN_DIR/jarela"
}

build_deb() {
  local root="$WORK_DIR/deb-root"
  copy_payload "$root"
  mkdir -p "$root/DEBIAN"
  local arch installed_size
  arch="$(dpkg --print-architecture)"
  installed_size="$(du -sk "$root/usr" | awk '{print $1}')"
  cat > "$root/DEBIAN/control" <<CONTROL
Package: jarela
Version: $VERSION
Section: utils
Priority: optional
Architecture: $arch
Installed-Size: $installed_size
Maintainer: CircuitWall <support@circuitwall.com>
Homepage: https://github.com/CircuitWall/jarela
Description: Local chat interface for LangGraph agents
 Jarela runs a local Next.js server at http://127.0.0.1:4312 and stores
 user data under ~/.jarela unless JARELA_DB_DIR is set.
CONTROL
  dpkg-deb --root-owner-group --build "$root" "$OUT_DIR/${PACKAGE_BASENAME}.deb"
}

build_rpm() {
  if ! command -v rpmbuild >/dev/null; then
    echo "rpmbuild not found; skipping RPM" >&2
    return 0
  fi

  local rpmbuild_root payload spec_version
  rpmbuild_root="$WORK_DIR/rpmbuild"
  payload="$WORK_DIR/rpm-payload/jarela-$VERSION"
  spec_version="${VERSION//-/_}"
  mkdir -p "$rpmbuild_root/BUILD" "$rpmbuild_root/RPMS" "$rpmbuild_root/SOURCES" "$rpmbuild_root/SPECS" "$rpmbuild_root/SRPMS"
  copy_payload "$payload"
  tar -czf "$rpmbuild_root/SOURCES/jarela-$VERSION.tar.gz" -C "$WORK_DIR/rpm-payload" "jarela-$VERSION"
  cat > "$rpmbuild_root/SPECS/jarela.spec" <<SPEC
Name: jarela
Version: $spec_version
Release: 1%{?dist}
Summary: Local chat interface for LangGraph agents
License: Apache-2.0
URL: https://github.com/CircuitWall/jarela
BuildArch: x86_64
Source0: jarela-$VERSION.tar.gz

%description
Jarela runs a local Next.js server at http://127.0.0.1:4312 and stores user
data under ~/.jarela unless JARELA_DB_DIR is set.

%prep
%setup -q -n jarela-$VERSION

%build

%install
mkdir -p %{buildroot}
cp -a usr %{buildroot}/

%files
/usr/lib/jarela
/usr/bin/jarela

%changelog
* Tue Sep 01 2026 CircuitWall <support@circuitwall.com> - $spec_version-1
- Package Jarela native Linux release artifacts.
SPEC
  rpmbuild --define "_topdir $rpmbuild_root" -bb "$rpmbuild_root/SPECS/jarela.spec"
  find "$rpmbuild_root/RPMS" -type f -name '*.rpm' -exec cp {} "$OUT_DIR/${PACKAGE_BASENAME}.rpm" \;
}

build_deb
build_rpm

echo "native Linux packages written to $OUT_DIR"