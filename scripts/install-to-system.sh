#!/usr/bin/env bash
# install-to-system.sh — macOS counterpart of install-to-system.ps1.
# Installs Jarela as a standalone app under ~/Library/Application Support/Jarela
# and registers a per-user LaunchAgent so it auto-starts at login.
#
# Data (SQLite, vector DB, OAuth tokens, memory, agents, models, MCP config,
# whitelist) lives at ~/.jarela and is shared between the dev repo and the
# installed copy — same DB, no migration step.
#
# Usage:
#   scripts/install-to-system.sh
#   scripts/install-to-system.sh --skip-build
#   scripts/install-to-system.sh --install-dir /opt/jarela
#   scripts/install-to-system.sh --no-start
#
# launchd does not inherit a login shell environment, so the installed
# service cannot reach a corp proxy unless we plumb credentials through.
# We split that into two layers:
#   - Non-secret env (NO_PROXY, NODE_EXTRA_CA_CERTS, PORT, etc.) goes into
#     the plist directly.
#   - Secrets (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY — they embed creds) live
#     in ~/.jarela/proxy.env (mode 600). A launcher.sh shim sources that
#     file before exec'ing node, keeping the world-readable plist clean.

set -euo pipefail

INSTALL_DIR="$HOME/Library/Application Support/Jarela"
SKIP_BUILD=0
NO_START=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --no-start)    NO_START=1; shift ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jarela.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DB_DIR="$HOME/.jarela"
LOG_DIR="$HOME/Library/Logs/Jarela"
PORT=4312

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# ── Sanity checks ──────────────────────────────────────────────────────────
[[ -f "$REPO_ROOT/package.json" ]] || { echo "package.json not found at $REPO_ROOT" >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm not on PATH"  >&2; exit 1; }
command -v node >/dev/null || { echo "node not on PATH" >&2; exit 1; }

NODE_BIN="$(command -v node)"
info "node: $NODE_BIN"
info "npm:  $(command -v npm)"
info "repo: $REPO_ROOT"
info "dest: $INSTALL_DIR"

# ── 1. Stop existing service ──────────────────────────────────────────────
step "Stopping existing LaunchAgent (if loaded)"
launchctl unload "$PLIST" 2>/dev/null || true
# Belt-and-braces: kill anything still on :4312.
if lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
  info "killing process on :$PORT"
  lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
fi
sleep 1

# ── 2. Build ──────────────────────────────────────────────────────────────
if [[ $SKIP_BUILD -eq 0 ]]; then
  pushd "$REPO_ROOT" >/dev/null
  if [[ ! -d node_modules ]]; then
    step "Installing build dependencies (npm ci)"
    npm ci
  fi
  step "Building production bundle (next build, output=standalone)"
  npm run build
  popd >/dev/null
fi

STANDALONE="$REPO_ROOT/.next/standalone"
STATIC_SRC="$REPO_ROOT/.next/static"
PUBLIC_SRC="$REPO_ROOT/public"
SERVER_JS="$STANDALONE/server.js"

[[ -f "$SERVER_JS" ]] || { echo "Standalone build missing at $SERVER_JS — re-run without --skip-build" >&2; exit 1; }

# ── 3. Clear install dir contents in place ────────────────────────────────
step "Clearing install dir contents at $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
# Clear contents but keep the directory itself (Finder/Spotlight may hold the dir handle).
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

# ── 4. Copy standalone bundle ─────────────────────────────────────────────
step "Copying standalone bundle"
# Standalone tree: server.js + minimum node_modules + package.json + hollow .next/
cp -R "$STANDALONE/." "$INSTALL_DIR/"

mkdir -p "$INSTALL_DIR/.next"
cp -R "$STATIC_SRC" "$INSTALL_DIR/.next/static"
cp -R "$PUBLIC_SRC" "$INSTALL_DIR/public"

# ── 5. Stamp install.json ─────────────────────────────────────────────────
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$INSTALL_DIR/install.json" <<JSON
{
  "installedAt": "$INSTALLED_AT",
  "commit": "$COMMIT",
  "sourceRepo": "$REPO_ROOT",
  "node": "$NODE_BIN",
  "port": $PORT,
  "dbDir": "$DB_DIR"
}
JSON

# ── 6. Drop launcher.sh next to server.js ─────────────────────────────────
# Plist runs this shim, which sources ~/.jarela/proxy.env (if present, mode
# 600) before exec'ing node. Keeps proxy creds out of the plist.
step "Writing $INSTALL_DIR/launcher.sh"
cat > "$INSTALL_DIR/launcher.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
PROXY_ENV="$HOME/.jarela/proxy.env"
if [[ -r "$PROXY_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$PROXY_ENV"
  set +a
fi
NODE_BIN="${JARELA_NODE:-__NODE_BIN__}"
exec "$NODE_BIN" "$HERE/server.js"
LAUNCH
# Substitute the captured node path so the shim still works if the user's
# PATH is empty when launchd invokes it.
sed -i '' "s|__NODE_BIN__|$NODE_BIN|" "$INSTALL_DIR/launcher.sh"
chmod +x "$INSTALL_DIR/launcher.sh"

info "files copied:"
for f in "$INSTALL_DIR"/*; do info "  $(basename "$f")"; done

# ── 7. Seed ~/.jarela/proxy.env if we have creds in the env and no file ───
# Only write it when the user already has corp creds set in their shell AND
# the file does not exist yet. Never overwrite — the user may have edited it.
mkdir -p "$DB_DIR"
PROXY_ENV_FILE="$DB_DIR/proxy.env"
if [[ ! -f "$PROXY_ENV_FILE" && ( -n "${HTTP_PROXY:-}" || -n "${HTTPS_PROXY:-}" || -n "${ALL_PROXY:-}" ) ]]; then
  step "Seeding $PROXY_ENV_FILE (mode 600)"
  {
    echo "# Sourced by launcher.sh at startup. Mode 600. Not checked in."
    echo "# Move proxy credentials here so they don't sit in the LaunchAgent plist."
    [[ -n "${HTTP_PROXY:-}"  ]] && printf "export HTTP_PROXY=%q\n"  "$HTTP_PROXY"
    [[ -n "${HTTPS_PROXY:-}" ]] && printf "export HTTPS_PROXY=%q\n" "$HTTPS_PROXY"
    [[ -n "${ALL_PROXY:-}"   ]] && printf "export ALL_PROXY=%q\n"   "$ALL_PROXY"
  } > "$PROXY_ENV_FILE"
  chmod 600 "$PROXY_ENV_FILE"
elif [[ -f "$PROXY_ENV_FILE" ]]; then
  info "preserving existing $PROXY_ENV_FILE"
fi

# ── 8. Write LaunchAgent plist ────────────────────────────────────────────
mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST")"

emit_env() {
  local key="$1" val="$2"
  if [[ -n "$val" ]]; then
    # XML-escape & < > " '
    val="${val//&/&amp;}"
    val="${val//</&lt;}"
    val="${val//>/&gt;}"
    val="${val//\"/&quot;}"
    val="${val//\'/&apos;}"
    printf '    <key>%s</key><string>%s</string>\n' "$key" "$val"
  fi
}

step "Writing $PLIST"
{
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/launcher.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOSTNAME</key><string>127.0.0.1</string>
    <key>NODE_ENV</key><string>production</string>
    <key>JARELA_DB_DIR</key><string>$DB_DIR</string>
    <key>JARELA_NODE</key><string>$NODE_BIN</string>
XML
  # Non-secret env only. HTTP_PROXY / HTTPS_PROXY / ALL_PROXY embed creds —
  # those go in $DB_DIR/proxy.env (mode 600) instead, sourced by launcher.sh.
  emit_env NO_PROXY            "${NO_PROXY:-}"
  emit_env NODE_EXTRA_CA_CERTS "${NODE_EXTRA_CA_CERTS:-}"
  cat <<XML
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/app.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/app.log</string>
</dict></plist>
XML
} > "$PLIST"

plutil -lint "$PLIST" >/dev/null

# ── 9. Load + start ───────────────────────────────────────────────────────
if [[ $NO_START -eq 0 ]]; then
  step "Loading LaunchAgent"
  launchctl load "$PLIST"
  sleep 2
  if launchctl list | grep -q "$LABEL"; then
    info "OK — LaunchAgent loaded"
  else
    info "WARNING — LaunchAgent did not register; check $LOG_DIR/app.log"
  fi
fi

echo
echo "Installed Jarela commit $COMMIT at $INSTALL_DIR"
echo "  URL:    http://localhost:$PORT"
echo "  Data:   $DB_DIR"
echo "  Logs:   $LOG_DIR/app.log"
echo "  Stop:   launchctl unload $PLIST"
echo "  Start:  launchctl load $PLIST"
echo
echo "The repo at $REPO_ROOT is now only needed for development / rebuilding."
