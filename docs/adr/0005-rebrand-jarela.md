# 5. Rebrand to Jarela

Date: 2026-05-17

## Status

Accepted.

## Context

The project was previously named "LangGUI". We rebranded to **Jarela** along with
a new logo (a stylized "J" with three pixel accents).

## Decision

Hard rename across the entire repo. No dual-name shims at the code level.

The only backward-compatibility seam is a **one-shot data-directory migration**
performed on first launch: if the legacy default directory `~/.langgui` exists
and the new default `~/.jarela` does not, `lib/db/data-dir.ts` renames the
directory and rewrites `langgui.db*` → `jarela.db*` in place.

## What changed

- Package name (`package.json`): `langgui` → `jarela`.
- PWA manifest (`public/manifest.json`): name, short_name, description.
- Document/page title (`app/layout.tsx`), Sidebar wordmark, AppShell title.
- Data dir: `~/.langgui` → `~/.jarela`. Main DB: `langgui.db` → `jarela.db`.
- Env vars: every `LANGGUI_*` → `JARELA_*` (DB_DIR, TEST_DB_DIR, TEST_PORT,
  PROD_DB, SEED_FROM_PROD, URL, VERBOSE, RECURSION_LIMIT, FRONTEND_ORIGIN,
  PORT, FRONTEND_PORT, WS_PORT, IMAGE_TIMEOUT_MS).
- Chat-model class: `LangGuiChatModel` → `JarelaChatModel` (file renamed too).
- `globalThis` keys: `__langgui_bridges`, `__langgui_notif_bus`,
  `__langgui_scheduler`, `__langguiWsState` → `__jarela_*` / `__jarelaWsState`.
- Tailscale WS sidecar path: `/__langgui_ws__` → `/__jarela_ws__`.
- CSS classes / keyframes: `.langgui-rich`, `.langgui-progress`,
  `langgui-progress-slide`, `langgui-toast-shrink` → `.jarela-*`.
- localStorage keys: `langgui:ws-url:v2`, `langgui:notif-banner-dismissed`,
  `langgui.notif.lastTs` → `jarela:*` / `jarela.*`. **No fallback read of
  the old keys** — existing browser profiles will quietly re-prompt for the
  WS URL and the notification banner once.
- DOM event: `langgui:focus-agent` → `jarela:focus-agent`.
- User-Agent header: `LangGUI/1.0` → `Jarela/1.0`.
- Windows install paths: `%LOCALAPPDATA%\Programs\LangGUI` →
  `%LOCALAPPDATA%\Programs\Jarela`. Logs:
  `%LOCALAPPDATA%\Jarela\logs`. Scheduled-task name `LangGUI` → `Jarela`.
- Script rename: `scripts/start-langgui.ps1` → `scripts/start-jarela.ps1`.
- New asset set generated from the supplied "J" PNG: `public/logo.svg`,
  `icon-192.png`, `icon-512.png`, `icon-192-maskable.png`,
  `icon-512-maskable.png`, `apple-touch-icon.png`, `favicon.ico`.

## Out of scope

- DB **table names** (`threads`, `messages`, `memory_store`, ...) — unbranded,
  unchanged.
- Removing an existing installed Windows scheduled task named `LangGUI`.
  Users are expected to re-run `scripts/install-to-system.ps1` after pulling.
- The legacy Vite SPA under `frontend/` and the dead `start.sh` shell launcher
  (both referenced an obsolete Python backend) were deleted in the same
  commit; they are not part of the Next.js runtime.

## Consequences

- Existing users with data under `~/.langgui` get a single rename on next
  launch and never see the legacy paths again.
- Users who set `LANGGUI_*` env vars must rename them. The app will not read
  the old names.
- Existing Windows installations (scheduled task + install dir) are
  orphaned until the user runs the new install script.
