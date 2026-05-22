# Jarela Page Capture — browser extension

Manifest-V3 extension. Lets the user pick an element on any page and POST
its content to the local Jarela process at `127.0.0.1:4312`. The capture
lands as a user message in the most-recently-updated thread; the user
then types their follow-up question in the Jarela web UI.

See [ADR-0018](../docs/adr/0018-browser-extension-page-capture.md) for the
design rationale and out-of-scope items.

## Load unpacked (Chrome / Edge / Brave / Arc)

1. Make sure Jarela is running locally (`npm run dev` from the repo root,
   default port 4312).
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder
   (`<repo>/browser-extension`).
4. Pin the Jarela icon to the toolbar.

The extension polls `GET /api/v1/health` every ~15 seconds. When Jarela
is reachable the icon is the active blue tile; when Jarela is down it
greys out and the tooltip says so. No state to clear when stopping —
just close the app and the icon disables on the next heartbeat tick.

## Using it

1. Click the toolbar icon on any web page.
2. A blue overlay tracks your cursor. Hover the part of the page you
   want to send.
3. Click. The element flashes; a "Sent" pill animates toward the toolbar
   icon; a banner confirms success and tells you whether the content was
   truncated.
4. Switch to the Jarela web UI — the captured content appears as a new
   user message. Type your follow-up.

Press **ESC** during the picker to cancel without sending.

## Files

| Path                       | Role                                            |
| -------------------------- | ----------------------------------------------- |
| `manifest.json`            | MV3 manifest                                    |
| `background.js`            | Service worker: health heartbeat, click router  |
| `content.js`               | Picker overlay + send animation                 |
| `content.css`              | Picker styles + keyframes                       |
| `lib/helpers.mjs`          | Pure helpers (also unit-tested via vitest)      |
| `lib/helpers.test.mjs`     | Vitest suite for the pure helpers               |
| `scripts/generate-icons.mjs` | Generates the placeholder solid-color PNGs    |
| `icons/*.png`              | Toolbar / store icons (placeholders today)      |

## Replacing the icons

The committed PNGs are programmatically generated solid-color tiles. To
replace with real art, drop new PNGs into `icons/` at sizes 16 / 32 /
128, with `-disabled` variants for the down state. Or edit
`scripts/generate-icons.mjs` and rerun
`node browser-extension/scripts/generate-icons.mjs`.

## Limits (v1)

- Loopback Jarela only (no tailnet capture from a remote browser).
- Top-level document tree only — iframes and shadow DOM are not picked.
- Single element per capture.
- Truncates at 100KB (server-side); the success banner notes when this
  happened and the message body shows a `> ⚠ Truncated` warning.
- No pairing token; anything on the user's loopback can POST to the
  capture endpoint. Same trust level as the rest of the v1 API surface.
