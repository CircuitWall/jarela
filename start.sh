#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT="${LANGGUI_PORT:-8000}"
FRONTEND_PORT="${LANGGUI_FRONTEND_PORT:-5173}"

cleanup() {
  echo ""
  echo "Stopping LangGUI..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# ── Backend ───────────────────────────────────────────────────────────────────
cd "$REPO_ROOT/backend"
if [ ! -d ".venv" ]; then
  echo "[backend] Creating virtualenv..."
  python3 -m venv .venv
fi
if [ ! -f ".venv/lib/python*/site-packages/fastapi" ] && \
   ! .venv/bin/python -c "import fastapi" 2>/dev/null; then
  echo "[backend] Installing dependencies..."
  .venv/bin/pip install -e "." --quiet
fi
echo "[backend] Starting on :${BACKEND_PORT}..."
LANGGUI_FRONTEND_ORIGIN="http://localhost:${FRONTEND_PORT}" \
  .venv/bin/uvicorn langgui.main:app \
    --host 127.0.0.1 \
    --port "$BACKEND_PORT" \
    --reload &
BACKEND_PID=$!

# ── Frontend ──────────────────────────────────────────────────────────────────
cd "$REPO_ROOT/frontend"
if [ ! -d "node_modules" ]; then
  echo "[frontend] Installing node modules..."
  npm install --silent
fi
echo "[frontend] Starting on :${FRONTEND_PORT}..."
npm run dev -- --port "$FRONTEND_PORT" &
FRONTEND_PID=$!

echo ""
echo "╔══════════════════════════════════╗"
echo "║          LangGUI running         ║"
echo "╠══════════════════════════════════╣"
echo "║  Frontend: http://localhost:${FRONTEND_PORT} ║"
echo "║  Backend:  http://localhost:${BACKEND_PORT}  ║"
echo "╚══════════════════════════════════╝"
echo "  Press Ctrl+C to stop."
echo ""

wait "$BACKEND_PID" "$FRONTEND_PID"
