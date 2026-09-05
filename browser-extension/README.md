# Jarela Page Capture — browser extension

Manifest-V3 extension. Lets the user pick an element on any page and POST
its content to the local Jarela process at `127.0.0.1:4312`. The capture
lands as a user message in the most-recently-updated thread; the user
then types their follow-up question in the Jarela web UI.

See [ADR-0018](../docs/adr/0018-browser-extension-page-capture.md) for the
design rationale and out-of-scope items.

## Rebranding

The extension is loaded as a folder of static files, so unlike the web app
(which reads `NEXT_PUBLIC_APP_*` at build time) rebranding it needs a
packaging step:

```bash
npm run build:extension -- --brand ./brand.json --out dist/my-extension
```

```jsonc
// brand.json — every key is optional
{
  "name": "Acme Assistant",
  "shortName": "Acme",
  "description": "Browser companion for Acme Assistant: …",
  "accentColor": "#7c3aed",       // picker outline / flash / send pill
  "logo": "./brand/mark.png"      // toolbar icons regenerated from this
}
```

The output is a ready-to-load extension folder with a templated
`manifest.json` (name, description, toolbar title, command description), a
regenerated `lib/brand.mjs`, and rebuilt icons. Test files and the icon
generator are excluded.

Run it **without** `--brand` and the output matches this in-tree extension —
`browser-extension/lib/brand.test.mjs` asserts that, so the two can't drift.

For upstream development just keep loading `browser-extension/` unpacked; no
build step is involved.

### How the strings flow

All product strings come from [`lib/brand.mjs`](./lib/brand.mjs). Because MV3
forbids inline `<script>`, static markup carries
`data-brand-template="{name} …"` placeholders that `applyBrand()` fills in on
load. `agent-overlay.js` is a classic content script that must register its
message listeners synchronously, so it paints placeholders first and brands
them once its dynamic `import()` resolves.

Internal identifiers are deliberately **not** rebranded — `chrome.storage`
keys (`jarelaConfig`), DOM ids (`#__jarela-overlay`), and CSS class/keyframe
names stay `jarela*`. They aren't product names, and renaming them would
orphan a user's stored config.

### Attribution

`UPSTREAM_NAME` / `UPSTREAM_URL` in `lib/brand.mjs` are never templated by the
build, and a rebranded build shows a "Powered by Jarela" link on the options
page. The upstream build itself shows nothing (the credit would be noise).

See [ADR-0077](../docs/adr/0077-rebranding-overlay-contract.md).

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

Each capture also includes a PNG screenshot of just the picked element
(best-effort — falls back to text-only if the browser denies a viewport
snapshot). The screenshot is cropped from `chrome.tabs.captureVisibleTab`
to the element's bounding rect at `devicePixelRatio` and shown inline in
the chat bubble. Vision-capable agents see the image on the silent
observer turn that fires immediately after the capture.

Press **ESC** during the picker to cancel without sending.

## Agent-driven browser control

When this extension is loaded, the agent can also drive your browser
through tools registered in the Jarela toolbelt:

| Tool                   | Action                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `browser_tabs`         | List open tabs, target markers, and URL/title metadata where permissions allow. |
| `browser_activate_tab` | Focus a tab by id from `browser_tabs`.                            |
| `browser_navigate`     | Open a URL (and optionally wait for a selector before resolving). |
| `browser_snapshot`     | Return a structured page inventory of headings, landmarks, and controls. |
| `browser_click`        | Click a selector, snapshot handle, or role/name locator.          |
| `browser_fill`         | Type into one input / textarea / contenteditable, optionally submit. |
| `browser_fill_many`    | Fill up to 25 fields in one browser round-trip, then optionally click a submit selector. |
| `browser_scroll`       | Scroll to `top`, `bottom`, or into-view of a selector.            |
| `browser_screenshot`   | Capture the viewport (or a selector); stored under `~/.jarela/files/`. |
| `browser_extract`      | Return `text` / `html` / `outerHTML` of a selector (default: `<body>`). |

For large pages, agents should use `browser_snapshot` to understand page
structure, then `browser_extract` for the actual page text or HTML. Small
extracts stay inline. Large or truncated extracts are reduced into a local
file artifact and return `result_ref.name`, `result_ref.uri`, a short preview,
and continuation metadata. Call `tool_result_get` with `result_ref.name` to
read the artifact, then call `browser_extract` again with `offset` set to
`next_offset` until `next_offset` is `null`. This keeps each tool result
prompt-sized without losing the rest of the page.

Screenshots are sidecars, not the primary reading channel. Use
`browser_screenshot` alongside extracted text when layout, charts, canvas,
or visual confirmation matter; use text/HTML extraction as the source of truth
for reading long content.

Complex pages can be expensive to rediscover. `browser_snapshot` now reuses a
recent in-process page map by default and returns `data.cache.hit: true` when it
did so. The snapshot includes a lightweight `fingerprint` so agents can tell
whether two observations describe the same control structure. Pass
`force_refresh: true` when the page has changed, after a long delay, or when a
handle/name lookup looks stale. State-changing browser tools still request a
fresh auto-snapshot after they act, so ordinary navigation and form workflows
refresh the cache naturally.

The service worker long-polls `/api/v1/extension/browser/poll` whenever
the local Jarela server is reachable. Commands target the pinned tab when
one is set, otherwise the last foreground tab the extension observed, then
the active tab in the last-focused browser window. There is no headless
browser process — your tab IS the browser. If the extension is not loaded
the agent's tool call fails quickly with a clear error and no command is
executed.

The popup now shows the current target plus a compact list of browser tabs.
From there you can focus a tab or pin a scriptable `http(s)` tab as the
agent's target without relying on repeated popup clicks. The Jarela app also
shows extension status and tab inventory under **Tools → Browser**.

When the Chrome side panel is opened, it adopts the currently active content
tab as the foreground browser context so follow-up agent work targets the page
the panel is sitting beside. An explicit pinned tab still wins; opening the side
panel never overrides a deliberate pin. If the current tab is not scriptable,
the extension falls back to the last-focused usable tab that is already part of
the browser context.

Tab URLs and titles are permission-sensitive browser metadata. The in-tree
manifest keeps broad host access optional; when Chromium withholds metadata,
Jarela shows the tab as metadata-unavailable instead of requesting wider
permissions silently.

### Ambient surroundings (side panel only)

While the side panel is open, the extension tells the app which page you are
looking at, so you can say "summarise this" without pasting a URL, and so notes
the agent already wrote about a site surface when you come back to it.

What is sent: URL, title, host, tab id. **Never page content** — the agent still
has to call `browser_extract` / `browser_snapshot`, with the usual approval
prompt, to read anything. The push is debounced, goes only to your local Jarela
over loopback, and the app holds it for at most 5 minutes in memory.

The consent window is the panel itself: the panel holds a port open, and closing
it retracts the record immediately. Nothing is pushed when the panel is closed.
Automation runs (scheduled tasks, watchers, triggers, fill/rewrite) never see it.
See ADR-0082.

### Per-site approval, sensitive actions, and on-tab overlay

The prompt exists to catch action you cannot **see**. When a command targets the
tab you are looking at, it runs without a modal: the blue "Jarela agent is
controlling this tab" banner narrates it live and **Stop** is one click away, so
a dialog would add friction without adding information.

A modal appears when the target is a tab you are *not* looking at — a pinned
background tab, or a tab in another window. It shows three buttons:

- **Approve once** — runs this single command.
- **Always allow on this site** — remembers the decision and skips
  future prompts for the same hostname, background tabs included.
- **Deny** — runs nothing now and remembers a deny. A denied host stays
  denied even on the focused tab, until you clear it.

Decisions live in `chrome.storage.local` under the `jarelaBrowserApprovals` key
as a flat `{ hostname: "always" | "denied" }` map, and that map is
authoritative. Approving a site for page control does **not** enrol it in cookie
passthrough: the *Sites the agent can use as you* list is a separate, stronger
grant you add deliberately in Settings, and nothing reconciles one against the
other.

When a prompt does appear it explains why the action is notable — whole-page
reads, screenshots, markup extraction, password/payment/auth-like fields, large
batch form fills, sensitive-looking hosts. The prompt never displays raw form
values.

While a command is executing, a blue **"Jarela agent is controlling this
tab"** banner is mounted at the top of the page with a pulsing indicator
and a **Stop** button. Pressing Stop persists a deny for the current host
and bounces any follow-up commands already queued. A subtle blue frame
outlines the viewport for the duration of the command. Both UI pieces
live inside a closed Shadow DOM so page CSS can't restyle or hide them.

Jarela also keeps a sanitized browser command ledger for the app UI under
**Tools → Browser**. The ledger records command type, status, host when known,
target tab id when returned, a short redacted summary, risk labels, and errors.
It does **not** store raw page extracts, screenshot pixels, cookies, tokens,
passwords, or full form values. Safe commands can be retried from the Browser
panel; form-fill commands are intentionally not retryable because their values
are not persisted.

While a command is running, the extension posts sanitized progress phases such
as `picked`, `approval_waiting_background`, `waiting_for_load`,
`waiting_for_selector`, and `snapshotting`. The Browser panel shows the latest
phase, and timeout errors include it so a stuck command points to the actual
recovery path instead of only saying that the extension timed out.

## Files

| Path                       | Role                                            |
| -------------------------- | ----------------------------------------------- |
| `manifest.json`            | MV3 manifest                                    |
| `background.js`            | Service worker: health heartbeat, click router, browser-control long-poll |
| `popup.html` / `popup.js`  | Quick actions: pick, refine, fill               |
| `content.js`               | Picker overlay + send animation                 |
| `content.css`              | Picker styles + keyframes                       |
| `lib/helpers.mjs`          | Pure helpers (also unit-tested via vitest)      |
| `lib/helpers.test.mjs`     | Vitest suite for the pure helpers               |
| `lib/browser-control.mjs`  | Dispatcher for agent-driven navigate/click/fill/scroll/screenshot/extract |
| `lib/browser-control.test.mjs` | Vitest suite for the dispatcher             |
| `lib/approvals.mjs`        | Per-host approval gate (always / denied / ask)  |
| `lib/approvals.test.mjs`   | Vitest suite for the approval gate              |
| `agent-overlay.js`         | Content-script overlay: approval modal + in-control banner |
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
