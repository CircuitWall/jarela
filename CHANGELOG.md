# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`browser_snapshot` tool — structured page reads, no vision needed.**
  Returns a compact JSON map of the active tab: URL, title, viewport,
  headings, ARIA landmarks, and a numbered list of every interactive
  control (links, buttons, inputs, selects, textareas, custom widgets)
  with `role`, accessible `name`, and a ready-to-use CSS `selector`
  the agent can pass straight to `browser_click` / `browser_fill`.
  Dramatically faster than the previous navigate → screenshot → vision
  → click loop: a snapshot is ~1–5 KB of text and skips the
  multi-second image upload + analysis round-trip on every step.
  The `browser_navigate` tool now points the agent at `browser_snapshot`
  by default; `browser_screenshot` stays for cases where the visual
  layout itself matters (charts, captchas, layout choices).
- **Tab pinning for the browser-control agent.** The popup now has a
  **Pin this tab** button that locks the agent onto a specific browser
  tab by ID. Once pinned, every browser-control command runs against
  that tab regardless of which window has focus — fixes the failure
  mode where opening the popup or side panel made
  `chrome.tabs.query({ active: true })` return the wrong (or no) tab
  mid-task. A pinned tab is auto-cleared when it's closed or navigated
  to a non-scriptable URL (chrome://, blank, extension page). When no
  pin is set the resolver falls back to the active http(s) tab in the
  last-focused window, skipping chrome:// / blank pages instead of
  silently failing.
- **Connection status indicator in the popup.** A coloured dot on the
  target-tab card shows whether the SW is currently connected to the
  Jarela server (green = healthy, red = unreachable), so the user can
  tell at a glance whether the extension can deliver agent commands.
- **Agent-driven browser navigation via the extension.** Six new tools
  register under the **Web** category and let an agent drive the user's
  active browser tab through the Jarela browser extension:
  `browser_navigate`, `browser_click`, `browser_fill`, `browser_scroll`,
  `browser_screenshot`, `browser_extract`. The agent enqueues commands
  on a server-side FIFO queue
  (`POST /api/v1/extension/browser/poll` long-poll,
  `POST /api/v1/extension/browser/result` submission); the extension
  service worker pulls them and executes them via
  `chrome.scripting.executeScript` in the active tab. Loopback-only auth
  on both endpoints. Screenshots are cropped to the element bounding
  rect via `OffscreenCanvas` and persisted under `~/.jarela/files/`.
  Commands time out cleanly when the extension is not loaded — no
  headless browser process is spawned, preserving the single-process
  invariant. Every command runs behind a per-host approval prompt
  rendered inside the target tab (Approve once / Always allow / Deny),
  and a "Jarela agent is controlling this tab" banner with a Stop
  button stays mounted while a command is executing so the user is
  always aware when the agent has control.

### Changed

- **Long-poll loop now backs off on consecutive errors.** Previously the
  extension service worker tight-looped on `/browser/poll` when the
  Jarela server was unreachable. It now waits `min(1s × 2^n, 30s)`
  between retries, resetting on any successful response. The 1-minute
  poll-revival alarm still covers full SW death; this just makes
  network-blip behaviour graceful.

## [1.7.0] - 2026-06-12

A feature drop on top of 1.6.0. Headline: outbound mask-and-rehydrate
redaction. API keys, personnummer, IBANs, and high-entropy secrets in
your messages and tool outputs are swapped for stable
`«SECRET:<id> type=<hint>»` placeholders before they cross the
provider boundary, then rehydrated to their real values before tool
execution and before the UI renders. The model can compose with
secrets it never sees ("put this key in the email body") while the
provider only ever receives the placeholder. Disabled with one toggle;
patterns are user-editable on disk.

### Added

- **Outbound mask-and-rehydrate redaction with UI transparency**
  ([#244](https://github.com/CircuitWall/jarela/pull/244), ADR-0064).
  Implements the trust boundary described in
  [docs/adr/0064-outbound-redaction-mask-and-rehydrate.md](./docs/adr/0064-outbound-redaction-mask-and-rehydrate.md).
  Mechanics:
  - **Outbound:** every message and tool-event payload is scanned just
    before `JarelaChatModel.toInvokeMessages`. Each match becomes
    `«SECRET:<id> type=<hint>»` with a coarse type bucket
    (`anthropic_api_key`, `personnummer`, `iban`,
    `unknown_long_string`, …) so the model has enough context to
    decide what to do with the value without seeing it. Same source
    value gets the same id within a thread so the model can refer
    back to "the key from earlier."
  - **Inbound — UI:** streamed assistant deltas pass through a
    rehydrator that holds back partial placeholders across chunks, so
    the user sees the real values they already own and never a
    half-token.
  - **Inbound — tool calls:** every tool argument is rehydrated
    *before* the tool executes via a Proxy wrapper that preserves
    LangChain's prototype dispatch. The "use this secret in a tool
    call without seeing it" flow is the load-bearing piece.
  - **Per-turn summary on every assistant row:** `redaction_summary`
    metadata records coarse type counts (never the values). The chat
    bubble renders a green ShieldCheck affordance — *"3 values held
    back from LLM"* — that expands to per-type counts. Without the
    surface the feature would be invisible.
  - **Settings panel under Profile → Security.** Toggle (default on),
    pattern-file path with *"Create default file"* / *"user-edited"*
    affordance, collapsible list of active patterns
    (name, type_hint, validator), allowlisted JSON field names, and
    inline copy explaining the trust boundary.
  - **User-editable patterns** at `~/.jarela/redaction-patterns.json`,
    hot-reloadable on file change. Defaults cover Anthropic / OpenAI /
    Cohere / Google API keys, Swedish personnummer, IBAN, and a
    high-entropy heuristic for unknown long strings. Allowlisted JSON
    field names (`prompt`, `query`, `text`, …) prevent the masker from
    eating tool inputs that legitimately look secret-shaped.
  - **Persistence is unchanged:** checkpoints continue to store the
    *unmasked* content, encrypted at rest by ADR-0005. Masking at
    rest would break thread resumption across processes (the
    rehydrate map is in memory) and gain little on top of existing
    encryption.
  - No behavior change when redaction is disabled — the chain reduces
    to a no-op `MaskContext`. All 1706 prior tests pass.

### Fixed

- **PIN keypad backspace renders the ← glyph**
  ([#243](https://github.com/CircuitWall/jarela/pull/243)). The
  setup-wizard PIN keypad was rendering the bare codepoint instead of
  the arrow on certain font stacks; switched to the explicit
  `←` literal so the glyph is consistent across platforms.

## [1.6.0] - 2026-06-12

A small feature drop on top of 1.5.0. Headline: agents can now use the
sites you're logged into in your browser — approve a host once in
Settings, and the Jarela browser extension transparently keeps the
server-side cookie store fresh as cookies change so `web_fetch` can
reach SSO-only intranets and personal-session endpoints without you
ever pasting a token.

### Added

- **Allowed-sites list with cookie passthrough for `web_fetch`**
  ([#241](https://github.com/CircuitWall/jarela/pull/241)). New Settings
  section *Sites the agent can use as you* — adding a host approves
  cookie passthrough for that host (and, in a follow-up, browser-RPC
  navigation). The browser extension watches `chrome.cookies.onChanged`
  for approved hosts and pushes the latest cookie set to Jarela
  automatically; `web_fetch` then attaches them on outbound requests
  with per-redirect re-resolution so off-list redirects strip
  credentials. Cookies are envelope-encrypted at rest (same scheme as
  proxy passwords) and never appear in the UI. Per-host *intranet*
  toggle opts the host past the SSRF guard so an internal Confluence /
  Jira / dashboard behind the corporate VPN is reachable without
  flipping the global `JARELA_ALLOW_PRIVATE_FETCH` escape hatch. RFC
  6265 path / Secure / expiry filtering happens server-side per
  request; suffix matching means approving `example.com` covers
  `*.example.com` automatically.

## [1.5.0] - 2026-06-11

A feature drop on top of 1.4.1. Headlines: WhatsApp bridges no longer
lose messages while the app is offline; the onboarding wizard is now a
real step-by-step flow; the in-chat `/compact` command preserves the
visible transcript and shows what it actually compressed; scheduled
tasks that fire while the app is locked are no longer silently dropped;
and large editor/panel components were split into focused sub-files for
maintainability.

### Added

- **Jira Align integration with write-side coverage**
  ([#238](https://github.com/CircuitWall/jarela/pull/238)). Adds a
  manifest entry and a `jira-align` tool that covers the write side of
  the Jira Align REST API (create / update / link work items), so an
  agent can drive an Align portfolio backlog end-to-end alongside the
  existing read-only coverage.
- **WhatsApp bridge catches up missed messages on reconnect**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). Baileys
  delivers offline-queued messages as `messages.upsert` type=`append`,
  not `notify`. The adapter previously ignored `append` batches —
  silently dropping every message received while the bridge was down.
  Now accepts both message types, watermarks per-route progress with a
  monotonic `last_seen_ts`, and dedupes against an LRU ring of the last
  ~2000 message IDs so a server restart no longer means lost messages.
- **Scheduled tasks deferred while the app is locked**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). Cron-fired
  tasks that hit a locked vault are queued instead of erroring; on the
  next unlock the scheduler replays them in order. Surfaces the deferred
  list in the UI so the operator can see what is waiting.
- **Onboarding wizard is now a real step-by-step flow**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). Replaces the
  scrollable cards with a fullscreen one-step-at-a-time wizard
  (Profile → Model → Agent → Review) so first-run users can't skip
  prerequisites. Each step is its own component under
  `components/setup/wizard/`.
- **Boot-time autostart in the installer**
  ([#232](https://github.com/CircuitWall/jarela/pull/232)).
  `install-startup.ps1` now accepts `-Boot` to register Jarela as a
  scheduled task that runs at machine startup (in addition to the
  existing logon trigger), so the launcher comes up before any user
  signs in.
- **Compaction stats on the context boundary chip**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). The divider
  between the warm summary and hot context now reads
  `N msgs · 18.2k → 1.4k (-92%)` so you can see at a glance what the
  most recent compact actually saved.

### Changed

- **Facts tier retrieves via semantic recall instead of substring LIKE**
  ([#239](https://github.com/CircuitWall/jarela/pull/239)).
  `buildFactsContext` previously shortlisted facts with a SQLite
  `LIKE %query%` against each fact's key+value, requiring a literal
  substring overlap between the question and the stored fact. It now
  routes through the same `recall()` cosine path used by the recall
  context tier, filtered to `namespace=facts`, so semantically related
  facts surface even when no words overlap. Substring `LIKE` is
  retained as a fallback for workspaces with no embedding provider
  configured.
- **`/compact` (`/new`) preserves the transcript**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). Compacting
  no longer wipes the visible chat. The hot/warm boundary moves to just
  after the last message and the summary lands behind the divider; the
  user can still scroll up through the prior turns. Long-term growth is
  still bounded — `JARELA_MAX_THREAD_MESSAGES` (default 1000) caps the
  retained transcript and `JARELA_MAX_SESSION_ARCHIVES` caps the
  per-agent session-summary archive.
- **Large editor/panel components split into focused pieces**
  ([#233](https://github.com/CircuitWall/jarela/pull/233)). `AgentEditor`,
  `ModelEditor`, `DocumentsPanel`, `ChatView`, `DashboardPanel` and the
  long tool-callback files in `lib/tools/` were broken into
  single-purpose sub-files and hooks. Mechanical extraction only — same
  props, same state — but each unit now fits on one screen and is
  independently testable.
- **Source-map and glob deprecation warnings remediated**
  ([#229](https://github.com/CircuitWall/jarela/pull/229)). Bumps
  transitive deps and silences the noisy warnings emitted on `next dev`.

### Fixed

- **Idle watchdog stays alive during silent tool-arg streaming**
  ([#240](https://github.com/CircuitWall/jarela/pull/240)). Some
  providers stream long tool-call argument JSON without emitting any
  user-visible token deltas, which used to trip the idle watchdog and
  abort the turn mid-tool-call. The watchdog now treats tool-arg
  chunks as a heartbeat so a slow function-call stream no longer
  cancels itself.
- **Warm summary no longer restates user identity**
  ([#237](https://github.com/CircuitWall/jarela/pull/237)). The
  summariser prompt was asking for "stable user facts," which made
  every `/compact` re-emit the user's name / email / location into the
  warm tier on top of the dedicated identity injection from
  `user_profile`. Tightened the prompt to explicitly skip identity
  fields so the warm summary stays focused on conversation content.
- **`/compact` extends the prior warm summary instead of resummarising
  every time** ([#235](https://github.com/CircuitWall/jarela/pull/235)).  Previously each `/compact` rebuilt the warm summary by passing every
  retained message back through the LLM. Two problems: (1) wasteful —
  long input every time and lossy summary-of-the-summary; (2) **unsafe**
  — once `pruneThreadMessages` had trimmed older rows past the retention
  cap, those rows were gone from the DB, so a from-scratch resummary
  silently dropped everything the previous summary used to cover. Now,
  when a non-empty warm summary already exists, the route only
  summarises the messages newer than `warm_summary_before` and folds the
  prior summary forward.
- **One PIN entry covers both decrypt and screen-unlock**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). Server-side
  complement to #226: `/api/v1/security/unlock` also clears the
  screen-lock flag on success, and `AppShell` renders only the decrypt
  overlay when both flags are up. Decrypting proves human presence,
  which is exactly what the screen-lock check confirms — so requiring a
  second PIN immediately afterwards was pure friction.
- **`/compact` flushes the message queue when it finishes**
  ([#234](https://github.com/CircuitWall/jarela/pull/234)). Messages
  typed while compaction was in flight previously stayed queued until
  the next user submit; they now drain automatically once the compact
  request resolves.
- **Drop the `+ N earlier` affordance from the context boundary
  divider** ([#234](https://github.com/CircuitWall/jarela/pull/234)).
  The link pointed at content already represented by the warm summary;
  the divider chip alone is enough.
- **Drop the redundant `/compact succeeded` toast**
  ([#235](https://github.com/CircuitWall/jarela/pull/235)). The boundary
  chip already shows the same `N msgs · before → after (-N%)` numbers
  immediately above; the toast was duplicating the same information.
- **Surface session and stream errors as toasts**
  ([#230](https://github.com/CircuitWall/jarela/pull/230)). 4xx/5xx
  responses from `/api/v1/agents/.../session` and stream-side aborts
  now produce an in-chat toast instead of failing silently.
- **Raise the recall budget for the agent boot path from 400 ms to
  1500 ms** ([#231](https://github.com/CircuitWall/jarela/pull/231)).
  Slow embedding models were timing out before recall could populate
  the warm context, which silently degraded answer quality on the very
  first turn.
- **README promo video renders with autoplay**
  ([#224](https://github.com/CircuitWall/jarela/pull/224)). Re-encoded
  the source promo so GitHub serves it as `video/mp4` instead of the
  audio-less webm (which the markdown sanitizer refused to render).



A reliability + UX polish patch on top of 1.4.0. The PIN keypad used at
boot-time decrypt and screen-unlock has been collapsed into a single
component with two modes, the API client treats both 423 lock states
symmetrically (master-key-locked is no longer surfaced as a toast
error), and several silent failure modes uncovered during last
night's launcher diagnosis are now bounded and observable.

### Changed

- **Unified PIN keypad**
  ([#226](https://github.com/CircuitWall/jarela/pull/226)).
  `UnlockScreen` and `ScreenLock` were near-duplicate 6-digit keypads;
  collapsed into a single `PinKeypad` with `mode: "decrypt" | "unlock"`.
  Both unlock paths converge on a shared `landOnAgentPicker()` so the
  user always lands on the agent selector. Boot-time decrypt now uses
  `router.refresh()` instead of a full `window.location.reload()`, so
  the transition to the AppShell is seamless. The API client handles
  423 `locked` symmetrically with `screen-locked` — neither lock state
  is surfaced as a toast error any more; the matching overlay mounts
  instead.

### Fixed

- **Bounded resource leaks and last-resort error handlers**
  ([#227](https://github.com/CircuitWall/jarela/pull/227)). Installs
  `process.on("uncaughtException")` and `process.on("unhandledRejection")`
  in `instrumentation-node.ts` so stray async errors land in the in-memory
  log ring instead of going to raw stderr or killing the server. The
  thread-run SSE route's `cancel()` now tears down its 500 ms poll and
  event subscriber on client disconnect; the provider-probe route clears
  its timeout on the win-path; `lib/tools/async-results` exposes
  `stopAsyncResults()` and the shutdown drain calls it. Gmail and GitHub
  page-walkers switched from `Promise.all` to `Promise.allSettled` so one
  failed item no longer bins the whole page. `AbortSignal.timeout()`
  added to the dashboard currency lookups (Nominatim, restcountries,
  open.er-api) and the GitHub-Copilot provider fetches.
- **Installer captures node stdio and bounds task retries**
  ([#225](https://github.com/CircuitWall/jarela/pull/225)). Replaces
  `Start-Process -RedirectStandardOutput/Error` (which silently dropped
  both streams under `wscript -> powershell`) with a raw
  `[System.Diagnostics.Process]` plus async `BeginOutputReadLine` /
  `BeginErrorReadLine` writing through autoflushed `StreamWriter` s, so
  `server.out.log` and `server.err.log` actually contain output. Logs
  node's exit code on every cycle. Tightens the in-launcher rate limiter
  from 5 to 3 restarts in 60 s. Reduces the scheduled-task retry policy
  from `RestartCount=999, RestartInterval=1m` to `RestartCount=3,
  RestartInterval=5m` — with an encrypted master key, every retry needs
  manual PIN re-entry, so 999 silent retries was strictly worse than
  failing loudly.
- **README promo video renders**
  ([#223](https://github.com/CircuitWall/jarela/pull/223)). GitHub raw
  was serving the audio-less `.webm` as `audio/webm` (mime-sniffer
  mis-classifies); browsers refused to render it in a `<video>`.
  Re-encoded to h264 mp4 (faststart, video-only) which raw.githubusercontent.com
  tags as `video/mp4`, and switched the README to absolute raw URLs for
  `src` and `poster` since the markdown sanitizer doesn't rewrite
  relative paths inside `<video>`.

## [1.4.0] - 2026-06-08

### Added

- **Browser-extension element screenshot.** The page-capture flow now
  ships a cropped PNG of the picked element alongside the text. The
  content script grabs the visible viewport via
  `chrome.tabs.captureVisibleTab` (loopback only, via the service worker)
  and crops it to the element's bounding rect through `OffscreenCanvas`
  at `devicePixelRatio`. The server validates the base64 payload (≤ 4 MB
  encoded), persists the user message as a multipart `ContentPart[]` of
  `[text, image]` so the bubble renders the picture inline, and
  forwards the image part to the silent observer turn so vision-capable
  agents see it on the immediate follow-up run. Falls back cleanly to
  text-only capture if the snapshot is denied. See
  [`docs/api.md`](./docs/api.md#post-apiv1page-capture) for the updated
  request schema.
- **Promo video recorder.** `npm run promo:record` (via
  [`scripts/promo-record.mjs`](./scripts/promo-record.mjs)) drives your
  real local install in a 9:16 vertical PWA viewport and records a
  dark-theme `.webm` of the tap-to-unlock intro, agent picker, a
  human-paced chat turn, and a tour of every side panel. First run
  saves auth state to `promo/.storage.json` and reuses it thereafter.

## [1.3.0] - 2026-06-08

Two new agent capabilities and a hardening pass on tool wall-clocks.
Bridge adapters (WhatsApp today) now spill large remote attachments
to a local store instead of inlining them into the LLM context, and
the agent picks them up by path through ``file_read``. Long-running
tool calls can now be fired asynchronously: the LLM gets a tracking
key back immediately and pulls the result later via a new built-in.

### Added

- **Bridge attachment spill store**
  ([#215](https://github.com/CircuitWall/jarela/pull/215)). Inbound
  bridge messages no longer base64-inline every document, voice note,
  audio, or video into the next prompt. Buffers are persisted under
  ``<dataDir>/bridge-attachments/<bridge>/<YYYY-MM-DD>/<id>-<name>``
  with sanitised paths, an SHA-256, and a future-facing
  ``pruneBridgeAttachments({ maxAgeMs })`` helper; the prompt body
  carries a text pointer telling the agent to use ``file_read`` to
  inspect the contents. Images and stickers ≤ 1 MB still inline so
  vision works out of the box.
- **Async tool execution (``async_run`` wrapper + ``tool_result_get``)**
  ([#216](https://github.com/CircuitWall/jarela/pull/216)). Every
  tool's schema now exposes an optional ``async_run: boolean``. When
  set, the wrapper returns ``{ok, async, key, tool, started_at,
  deadline_ms, hint}`` immediately and runs the work detached; the
  LLM picks the result up via the new built-in
  ``tool_result_get(key, wait_ms?, consume?)``. ``tool_result_list``
  returns summaries without dumping result bodies. In-process store
  with a 10-minute TTL and a 256-entry cap (oldest finished evicted
  first, then oldest pending with a warn).

### Changed

- **Hard ceiling on tool ``deadline_ms``**
  ([#216](https://github.com/CircuitWall/jarela/pull/216)). The
  wall-clock budget the LLM can pick is now clamped to 30 minutes by
  default. Values above the ceiling are clamped and a one-line
  ``console.warn`` is emitted naming the tool, the requested value,
  and the ceiling. Operators can raise or lower the cap with the new
  ``JARELA_TOOL_MAX_DEADLINE_MS`` environment variable (integer
  milliseconds). Applies to both sync and ``async_run`` paths.

### Fixed

- **E2E menu specs no longer race the boot agent picker**
  ([#217](https://github.com/CircuitWall/jarela/pull/217)). Three
  Playwright specs (``layout``, ``credentials``, ``setup-reorg``)
  were intermittently failing because the BootScreen overlay
  intercepted clicks on the header menu button. A new
  ``waitForAppReady(page)`` helper picks the default agent tile and
  waits for the overlay to detach before the test drives the UI.

### Configuration

- ``JARELA_TOOL_MAX_DEADLINE_MS`` — overrides the per-tool
  wall-clock ceiling (default 1800000 ms / 30 min). Set to a smaller
  value to tighten the cap, or larger if a regulated workload genuinely
  needs long synchronous calls.

Two follow-up fixes on top of 1.2.0.

### Fixed

- **Boot agent picker always shows after login**
  ([#213](https://github.com/CircuitWall/jarela/pull/213)). The picker
  was being skipped in some session states; it now reliably appears so
  the user actively chooses an agent at boot instead of silently
  inheriting one.
- **Extension UX polish on one-shot turns**
  ([#212](https://github.com/CircuitWall/jarela/pull/212)). Custom
  intent collapses by default, Enter submits, writes are queued, and
  one-shot turns drop the quality gates that didn't apply to them.

## [1.2.0] - 2026-06-08

Security, runtime resilience, and a broad UI consolidation pass.
The Setup surface gets a noticeable cleanup (capabilities all under
one tab, MCP and connections folded in where they belong), runs now
have proper watchdog coverage everywhere with an adaptive wall-clock
that doesn't punish slow tools, and the on-disk keyfile can be
PIN-protected with an auto-lock when the app idles.

### Added

- **PIN-protected keyfile + idle screen lock**
  ([#200](https://github.com/CircuitWall/jarela/pull/200), ADR-0063).
  The local keyfile that wraps credentials and memory rows can now be
  protected by a user-set PIN, and the app auto-locks after an idle
  timeout so a left-open browser tab no longer exposes secrets at rest.
- **Per-turn output-token budget injected into the system prompt**
  ([#197](https://github.com/CircuitWall/jarela/pull/197)). The agent
  now sees the per-turn output ceiling alongside the context window
  so it can plan its response length instead of getting truncated
  mid-thought.
- **Network env vars in the profile panel**
  ([#201](https://github.com/CircuitWall/jarela/pull/201)). Proxy and
  bind-address knobs now live next to the rest of the user profile
  instead of buried in env panels.

### Changed

- **Capability surfaces consolidated under the Tools tab**
  ([#208](https://github.com/CircuitWall/jarela/pull/208)). Built-in
  tools, MCP servers, and connections each used to have their own
  top-level tab; they're now sub-tabs under one Tools surface.
- **MCP server management lives under Tools**
  ([#203](https://github.com/CircuitWall/jarela/pull/203)). Setup
  step in the larger consolidation.
- **Connections folded back into Credentials**
  ([#204](https://github.com/CircuitWall/jarela/pull/204)).
  Connections and credentials always referred to the same underlying
  rows; the split surface is gone.
- **Workspace mode as a segmented switch**
  ([#207](https://github.com/CircuitWall/jarela/pull/207)). Replaces
  a single confusing toggle label with an explicit two-option switch.
- **Show-tools / show-thinking toggles and the test-notification
  button removed** ([#202](https://github.com/CircuitWall/jarela/pull/202)).
  Dead UI dropped during the consolidation.
- **Model config, credentials, citations, icons, and chat perf
  polish** ([#194](https://github.com/CircuitWall/jarela/pull/194)).
  Visual + interaction polish across the model picker, credential
  rows, in-message citations, lucide icons, and message-list
  re-render hot paths.

### Fixed

- **Adaptive wall-clock watchdog with full entry-point parity**
  ([#209](https://github.com/CircuitWall/jarela/pull/209)). The
  run-registry's idle and wall-clock watchdogs now wrap every
  agent run — not just HTTP chat, but triggers, watchers, bridges,
  the scheduler, the extension callback, and the delegate runner.
  The wall-clock now bounds *agent + provider* time only: time
  spent inside a tool call (`exec`, MCP, `fetch`) no longer counts
  against the agent's budget, so a slow tool can't force-stop a run
  that's otherwise making progress. Each tool already enforces its
  own per-call timeout.
- **Interrupted turns persist so the agent sees the cut**
  ([#206](https://github.com/CircuitWall/jarela/pull/206)). Stopping
  a turn mid-stream now writes the partial assistant message
  with a clear interrupted marker, so the next turn doesn't replay
  the same prompt against a half-written history.
- **Scroll-to-latest button offset below glass header**
  ([#205](https://github.com/CircuitWall/jarela/pull/205)). Button
  no longer hides behind the translucent app bar on tall threads.
- **Glass blur restored** ([#198](https://github.com/CircuitWall/jarela/pull/198)).
  Reorders the `backdrop-filter` declarations so the blur layer
  paints in browsers that picked the wrong cascade order.
- **iOS standalone PWA viewport-height shim**
  ([#196](https://github.com/CircuitWall/jarela/pull/196)). Patches
  the long-standing iOS Safari bug where `100vh` in a home-screen
  app is taller than the actual visible viewport.
- **System theme: `color-scheme: light dark`**
  ([#195](https://github.com/CircuitWall/jarela/pull/195)). Restores
  native form-control theming on macOS / iOS when the OS theme is
  set to follow the system.
- **Dependencies refreshed** ([#210](https://github.com/CircuitWall/jarela/pull/210)).
  Lockfile-only `npm update` covering 99 in-range transitive bumps
  across `@smithy/*`, `@aws-sdk/*`, `@langchain/*`, and shared
  tooling.

### Tests

- **`fs-watch` e2e spec skipped on non-macOS**
  ([#199](https://github.com/CircuitWall/jarela/pull/199)). Removes
  a persistent CI flake on Linux runners where the watcher's wakeup
  latency exceeded the spec's budget.

## [1.1.0] - 2026-06-07

Browser-extension UX is unified behind a single Alt+J action menu and
two Gemini one-shot regressions are fixed.

### Added

- **Unified Alt+J action menu in the browser extension**
  ([#192](https://github.com/CircuitWall/jarela/pull/192)). Alt+J and
  the single context-menu entry now open a centered floating menu
  inside the page, so it works on hosts that hijack the native
  right-click (Outlook PWA, custom rich editors). The menu shows the
  captured selection preview plus rewrite preset chips (improve
  clarity, concise, formal, friendly, technical) when text is
  selected, and a collapsible custom-intent textarea. Selection inside
  a focused editable is rewritten in place via the same write path as
  fill; selection outside lands on the clipboard. Replaces the prior
  split Alt+J / Alt+Shift+J shortcuts and the rewrite-direction
  context submenu.

### Fixed

- **Gemini one-shot turns** ([#192](https://github.com/CircuitWall/jarela/pull/192)).
  The native Gemini adapter rejected fill / rewrite turns because the
  one-shot path emitted an empty messages array; it is now seeded
  with the system prompt.
- **Recall / facts leak into one-shot turns**
  ([#192](https://github.com/CircuitWall/jarela/pull/192)). One-shot
  fill / rewrite turns no longer pull from the recall and facts
  memory stores, so prior fills cannot leak into later ones.
- **Selection capture across element-node containers**
  ([#192](https://github.com/CircuitWall/jarela/pull/192)). Captures
  caret and range as text-offsets on a `data-jarela-fill-target`
  dataset attribute, measured via a synthetic range. Multi-paragraph
  selections in Gmail / Outlook now capture correctly instead of
  collapsing to zero, and the offsets survive framework
  reconciliation where a marker span would be stripped. Also removes
  an `allFrames: true` iframe-drilling race that caused the top
  frame to double-mark the iframe's editable.

### Changed

- **Extension turn instruction cap raised from 2 000 to 16 000 chars**
  ([#192](https://github.com/CircuitWall/jarela/pull/192)) so the
  unified fill prompt no longer trips a 400.
- **Tool capability re-classification.** The `Capability` axis now
  reflects what a non-power user expects to see, not the HTTP method.
  Record edits (create / update / delete / add / move / upload / draft)
  are `write` regardless of whether they hit local SQLite or a remote
  API. `execute` is reserved for tools that *perform an action* beyond
  editing a record: arbitrary code (shell), server lifecycle (restart,
  env-var), generated artifacts (image, voice), agent delegation,
  workflow transitions (Jira / JA `transitions`), and PR merges. About
  fifty tools moved from `execute` to `write` across Atlassian,
  GitHub, Gmail, Outlook, Calendar, and Jira Align. ADR-0038 amended
  to drop the locality-based tie-breaker.

## [1.0.0] - 2026-06-06

First **stable** release. The package surface is now formally locked,
Anthropic prompt caching is enabled with cost-correct per-turn
accounting, and agents can introspect their own toolbelt at runtime.

### Breaking

- **`./*` wildcard removed from `package.json#exports`.** Consumers can
  now import only from the five paths in the explicit contract table
  (`./lib/providers/types`, `./lib/tools/types`, `./lib/tools/registry`,
  `./lib/mcp/registry`, `./package.json`). Anything else is internal
  and resolves to a Node `ERR_PACKAGE_PATH_NOT_EXPORTED`. ADR-0061
  captured the planned lockdown; this is the cut. From this release
  forward, the deprecation policy in CONTRIBUTING.md applies: removing
  or breaking any public export bumps MAJOR.

### Added

- **Anthropic prompt caching**
  ([#181](https://github.com/CircuitWall/jarela/pull/181)). The
  Anthropic adapter now marks the system block, the tools block, and
  the most-recent tool result with
  `cache_control: { type: "ephemeral" }`. Cuts cost on multi-step
  ReAct turns where the same prefix repeats on every step. ADR-0062
  documents the breakpoint placement.
- **Per-turn cost reflects Anthropic cache pricing**
  ([#183](https://github.com/CircuitWall/jarela/pull/183),
  [#185](https://github.com/CircuitWall/jarela/pull/185)). The
  `message_usage` table gained two nullable columns
  (`cache_creation_input_tokens`, `cache_read_input_tokens`). The
  agent loop reads them from the provider stream via LangChain's
  standard `usage_metadata.input_token_details` channel, persists
  them, and `estimateCostUsd` now prices them at 1.25× / 0.1× the
  input rate. The dashboard's totals are correct end-to-end.
- **Cache-hit indicator under each assistant turn**
  ([#187](https://github.com/CircuitWall/jarela/pull/187)). The chat
  panel's per-turn usage bar shows a
  `cache hit · Nk read · cache write · Mk` chip when caching fires,
  with a `Cache` row in the expanded numeric details and full numbers
  in the bar tooltip.
- **`MessageUsage.cache_creation_input_tokens` /
  `cache_read_input_tokens`** added to the wire contract type so
  external consumers of `GET /api/v1/threads/<id>` see the same shape
  the chat UI does.
- **Public API surface declared** for the npm package
  ([#182](https://github.com/CircuitWall/jarela/pull/182), ADR-0061).
  `package.json#exports` is the single source of truth for what's
  contractually public; the deprecation policy in CONTRIBUTING.md
  defines the change rules.
- **[`docs/EXTENDING.md`](./docs/EXTENDING.md)** — single integration
  guide covering all seven extension surfaces (built-in providers,
  external `.cjs` provider plugins, built-in tools, MCP servers, agent
  harnesses, integration manifests, brand overlays).
- **[`docs/api.md`](./docs/api.md)** — HTTP API reference listing only
  the stable `@public` routes (health, threads, agents, tools, models,
  providers, events SSE, page-capture).
- **Four new agent-introspection tools** (`Config` category, `read`
  capability): `list_tools`, `list_providers` + `describe_provider`,
  `list_mcp_servers`, `describe_extension_surfaces`. Lets an agent
  answer "what can I do" / "how do I add an X" without out-of-band
  docs.
- **Deprecation policy** in CONTRIBUTING.md — public APIs get one
  minor version cycle of deprecation before removal; internals can
  change anytime.
- **JSDoc `@public` headers** on the four contract type files
  (`lib/providers/types.ts`, `lib/tools/types.ts`,
  `lib/tools/registry.ts`, `lib/mcp/registry.ts`) and on the eleven
  public HTTP route files.

### Changed

- `lib/tools/index.ts` no longer snapshots the built-in tool list at
  module-load time. Replaces the `ALL_BUILTINS` / `BUILTIN_TOOL_NAMES`
  constants with live accessors so tool modules that import back from
  `index` (for `getAllToolsAsync` etc.) can register without falling
  out of the snapshot.
- `BUILTIN_TOOL_NAMES` export replaced with `getBuiltinToolNames()`
  function. The two in-app callers (`/api/v1/extensions` routes) are
  updated.

### Fixed

- README "Extending" TOC link no longer points to a non-existent
  `#extension-points` anchor; it now links to `docs/EXTENDING.md`.
- README "Add a built-in tool" walkthrough updated to the
  post-ADR-0038 three-arg
  `registerTools(category, capability, [...])` signature
  ([#184](https://github.com/CircuitWall/jarela/pull/184)).

## [0.14.0] - 2026-06-05

Mobile-focused polish release. iOS Safari PWA now correctly survives the
on-screen keyboard after a research-backed simplification — see
[Francisco Moretti's writeup](https://www.franciscomoretti.com/blog/fix-mobile-keyboard-overlap-with-visualviewport)
and the [`ios-pwa-keyboard-fix`](https://github.com/Crscristi28/ios-pwa-keyboard-fix)
reference implementation — and the countdown ring animation is visible
again.

### Changed

- **iOS PWA viewport switched to `100dvh` natively**
  ([#178](https://github.com/CircuitWall/jarela/pull/178)). Replaces the
  `useVisualViewportInsets` JS hook, the `--visual-vh` / `--kb-inset` /
  `--kb-scroll-offset` CSS variables, and the
  `body { position: fixed; inset: 0 }` lock with the standard
  `html, body { height: 100% }` + `h-[100dvh]` pattern. The browser
  natively tracks the visible viewport including the OS keyboard on
  iOS 16.4+ and modern Chromium. Net `-98 LOC`.
- **`interactiveWidget: "resizes-content"` viewport meta**
  ([#174](https://github.com/CircuitWall/jarela/pull/174)). Lets
  Chromium shrink the layout viewport when the OS keyboard appears, so
  `100dvh` sits naturally above the keyboard.

### Fixed

- **Countdown ring motion is obvious again**
  ([#172](https://github.com/CircuitWall/jarela/pull/172)). The ring's
  motion was too subtle to register as a countdown.
- **Chat input visible when the iOS keyboard opens**
  ([#173](https://github.com/CircuitWall/jarela/pull/173),
  [#175](https://github.com/CircuitWall/jarela/pull/175)). Initial fix
  pinned the composer to the visual viewport; follow-up removed double-
  compensation that lifted the bar by 2× the keyboard height.
- **MessageList re-pins to the bottom on container resize**
  ([#176](https://github.com/CircuitWall/jarela/pull/176)). When the
  on-screen keyboard shrinks AppShell via `100dvh` without a React
  render, a `ResizeObserver` keeps the latest messages in view.
- **Shrink "chin" below the input bar on iPhone**
  ([#179](https://github.com/CircuitWall/jarela/pull/179)). Bottom
  padding switched from `calc(0.75rem + env(safe-area-inset-bottom))`
  to `max(0.25rem, env(safe-area-inset-bottom))`. Home-indicator and
  rounded-corner clearance preserved, ~12px of constant chin removed.

## [0.13.0] - 2026-06-04

Follow-up release on top of 0.12.0 with anti-hallucination tooling, more
direct send-bar controls, and watchdog/idle-loop fixes shaken out of
real-world long-running tasks.

### Added

- **Configurable anti-hallucination classifier.** New per-agent
  classifier with `off` / `report` / `enforce` modes that catches
  fabricated tool results and assertion drift, surfaced via a model
  picker in the agent editor.
- **Explicit Steer / Queue / Interrupt actions on the send button**
  ([#165](https://github.com/CircuitWall/jarela/pull/165)). Replaces
  the implicit "send during a turn = ???" behaviour with three
  unambiguous actions so a follow-up message can be steered into the
  running turn, queued for after it finishes, or used to interrupt.

### Changed

- **Default timeouts and fetch byte cap raised for long-running tasks**
  ([#166](https://github.com/CircuitWall/jarela/pull/166)). Operational
  defaults adjusted so a multi-step research / migration run no longer
  trips watchdogs or fetch caps that were sized for chat-shaped turns.

### Fixed

- **Idle watchdog pauses while tool calls are in flight**
  ([#163](https://github.com/CircuitWall/jarela/pull/163),
  [#164](https://github.com/CircuitWall/jarela/pull/164)). A long
  `exec`/`fetch` no longer trips the "no progress" detector and
  cancels its own turn.
- **Wall-clock deadline on every built-in `fs.*` call.** Read/write/
  list operations now honour a hard deadline so a slow disk or a
  pathological glob cannot hang a turn indefinitely.
- **Stall detector catches mid-sentence "now" forms.** Previously only
  matched sentence-final cues; now also flags `I'll X ... now` /
  `I'm X ... now` patterns that historically slipped through.
- **Watchdog timeouts surface as visible errors instead of silent
  hangs.** Failed turns now emit an explicit error event so the UI can
  show what happened rather than appearing to stall.

## [0.12.0] - 2026-06-04

This release line is rebuilt onto the v0.9.0 base via a selective replay
of the v0.10.0 line, then layers in the user-facing parts of v0.11.x and
a focused set of new features. The deeper 0.11.x agent-loop refactor
(#129–#145, #151–#152, #157) is deliberately not included.

### Added

- **Per-channel warm summary store
  ([ADR-0044](docs/adr/0044-per-channel-warm-summary-and-attributed-context.md)).**
  New `thread_channel_summaries` table keyed by `(thread_id, channel)`
  so a thread shared across `chat` / `scheduled_task` / `watcher` /
  `bridge` channels stops blending automation history into interactive
  turns. Storage layer only — prompt-assembly wiring follows.
- **Live server-log panel
  ([ADR-0058](docs/adr/0058-logs-panel.md)).** In-app filterable
  scrollback over a 2000-entry ring with idempotent console patch +
  redaction of `Authorization` / `api_key` / `sk-…` / `ghp_…` tokens,
  exposed via `/api/v1/logs` SSE with replay. Mounts as an Advanced tab.
- **Runtime env overrides
  ([ADR-0060](docs/adr/0060-env-overrides-and-config-schema.md)).**
  ~40 `JARELA_*` operational knobs centralised behind a single schema
  driving the typed config snapshot, per-deployment overrides at
  `{dataDir}/env-overrides.json`, REST surface, agent tools
  (`set_env_var`, `restart_server`), and a new EnvVarsPanel UI.
- **Anti-hallucination stall-retry detector.** Catches three failure
  modes in one pass: same `(tool, args)` signature recurring ≥3× in a
  turn (ReAct loop), promised-write stalls (model called read-only
  tools then ended on `writing X now` / `saving the file now`), and
  the original zero-tool stall path. New `_skip_persist_message` +
  `_inject_message_into_history` flags keep the auto-retry nudge in
  front of the LLM but out of persisted history.
- **Model catalog browse accepts in-form credentials, allowlist
  removed.** `POST /providers/:p/models` accepts `{ params }` overrides
  so a freshly-typed `api_key` / `base_url` works before the user has
  clicked Save. Hardcoded `CATALOG_PROVIDERS` allowlist gone.

### Changed

- **Per-model context-tier UI removed from ModelEditor.** Per-agent
  override (ADR-0043) already supersedes the model-level value at run
  time, so the knob was duplicate UX. Payload-building lifted into
  `lib/models/editor-payload.ts` with 15 unit tests including a
  round-trip through `upsertModelConfig`.

### Fixed

- **SSE connect timeout configurable.** Replaces the hardcoded 8s with
  `JARELA_SSE_CONNECT_TIMEOUT_MS` (default 30s, surfaced via the
  runtime config layer to the browser). Plus plain-English wording for
  the user-facing toast (was `Error: EventSource connect timeout`, now
  `Connection timed out — the server didn't respond within Ns.`).
- **`request()` helper respects `httpRequestTimeoutMs` and
  `httpMaxAttempts`.** Both knobs were defined in the runtime config
  schema with descriptions naming this code path but were never read.
- **OpenAI-compat adapters emit stream usage events.** *(0.11.0
  backport.)* Both `lib/providers/openai.ts` and
  `lib/providers/github-copilot.ts` send
  `stream_options: { include_usage: true }` and yield a `usage` chunk;
  ADR-0041 token accounting reflects real provider counts instead of
  content-length estimates.
- **Drop orphaned checkpoint rows on thread delete.** *(0.11.1
  backport.)* `DELETE /api/v1/threads/{id}` now calls
  `getCheckpointer().deleteThread(id)` so deleted threads' LangGraph
  rows are reclaimed instead of growing monotonically.
- **Pricing lookup handles aggregator-namespaced model ids.** *(0.11.2
  backport.)* Models exposed by aggregators (OpenRouter, LiteLLM) with
  a `vendor/model` prefix now resolve via the bare suffix; the
  github-copilot upstream-inference path strips the prefix too.
- **Hardcoded known-rates fallback for canonical model ids.** *(0.11.3
  backport.)* New `lib/stores/known-rates.ts` consulted as a 4th tier
  after the snapshot lookups so dashboard cost columns no longer go
  blank when the live extractor loses data. Snapshot still wins when
  present.

## [0.10.0] - 2026-06-02

### Added

- **Stacked per-tier token + cost breakdown in the dashboard chart**
  ([#119](https://github.com/CircuitWall/jarela/pull/119)). The unified
  chart now stacks `system / history / live / output` segments and
  surfaces a data-quality chip so operators can spot tiers that fell
  back to estimation.
- **`JARELA_TOOL_SAFETY` tiers for exec + file ops**
  ([#121](https://github.com/CircuitWall/jarela/pull/121)). Adds a
  capability-flagged safety ladder so risky tools (shell exec, file
  writes) can be gated independently per deployment.
- **Idle-progress watchdog in the run-registry**
  ([#123](https://github.com/CircuitWall/jarela/pull/123)). Force-
  finishes runs that stop emitting progress for `JARELA_RUN_IDLE_MS`,
  complementing the existing wall-clock watchdog.
- **System prompt now nudges the agent about indexed documents**
  ([#125](https://github.com/CircuitWall/jarela/pull/125)). When the
  workspace has documents indexed, the prompt mentions the
  `documents_search` tool so agents recall RAG before answering from
  parametric memory.
- **Trigger-originated chat messages now render as metadata cards**
  ([#127](https://github.com/CircuitWall/jarela/pull/127)). Scheduled
  tasks (ADR-0032) and watchers (ADR-0027) get a Clock / Eye header,
  a tool-name pill, a `silent` pill when the firing was silent, and a
  collapsible "Change context" section for watcher diffs. Falls back to
  plain rendering if the prompt text doesn't parse cleanly.

### Fixed

- **Collapse tool-permission categories by default in the agent editor**
  ([#118](https://github.com/CircuitWall/jarela/pull/118)) so the
  panel doesn't open with a wall of toggles.
- **Clear stuck "reconnecting…" state when reattach returns 404**
  ([#120](https://github.com/CircuitWall/jarela/pull/120)).
- **Guarantee `finishRun` + add watchdog for leaked runs**
  ([#122](https://github.com/CircuitWall/jarela/pull/122)) so
  abandoned runs can't keep the registry marked `running` forever.
- **Harden SSE run subscription against hung streaming gate**
  ([#124](https://github.com/CircuitWall/jarela/pull/124)).
- **Stabilise two pre-existing e2e flakes**
  ([#126](https://github.com/CircuitWall/jarela/pull/126)). The
  context-bar legend test now scopes its locator by `[data-message-id]`
  so parallel sibling tests can't cross-pollute, and the profile
  test uses `page.goto("/?tab=profile")` instead of `page.reload()`
  to deflake mobile-safari.

## [0.9.3] - 2026-06-01

### Changed

- **Threads GET serializer extracted into `lib/api/serializers.ts`.**
  The per-message `usage` and `context_window_tokens` shaping that the
  `ContextUsageBar` consumes was inlined in the route, untestable, and
  prone to drift. The route now delegates to
  `messageToResponse` / `messageUsageToResponse` /
  `resolveContextWindowTokens`, each with unit coverage in
  [lib/api/serializers.test.ts](lib/api/serializers.test.ts). No wire
  contract change.

### Fixed

- **`delegate_to_agent` test signature** updated for the new
  `contextSnapshot` argument added to `persistAssistantMessage` in #112
  ([lib/tools/delegate.test.ts](lib/tools/delegate.test.ts)).

## [0.9.2] - 2026-06-01

### Changed

- **iOS standalone PWA now follows the active theme in the status bar.**
  Switched `apple-mobile-web-app-status-bar-style` to
  `black-translucent` and declared `apple-mobile-web-app-capable`, so
  the iOS status bar overlays the AppShell header (already padded with
  `env(safe-area-inset-top)` via `--app-safe-top`) and inherits the
  current light / dark surface color instead of forcing a static black
  or white bar. Safari ignores the manifest's `theme_color` once an app
  is installed to the home screen, so this is the only knob iOS
  actually respects ([app/layout.tsx](app/layout.tsx)).

## [0.9.1] - 2026-06-01

### Fixed

- **Per-turn context-usage bar now actually persists.**
  `message_usage.cost_usd` is `NOT NULL` in the schema, so snapshot-only
  inserts (provider didn't report token usage) were silently rejected
  and the bar never rendered. Default the fallback cost to `0` so the
  row lands
  ([lib/agents/run-thread.ts](lib/agents/run-thread.ts),
  [lib/stores/message-usage.ts](lib/stores/message-usage.ts)).
- **Last assistant bubble no longer auto-collapses mid-read.** The
  streaming bubble and the persisted bubble are two different React
  instances (`key={msg.id}` remounts when the stream finalises), so
  the streaming-aware “keep open” latch never carried over.
  `MessageList` now passes `isLatest` to the last visible message and
  `CollapsibleLong` treats it as `defaultOpen`
  ([components/chat/MessageBubble.tsx](components/chat/MessageBubble.tsx),
  [components/chat/MessageList.tsx](components/chat/MessageList.tsx)).
- **`dashboard-metrics` snapshot gate** no longer suppresses
  content-length cost estimates for rows whose snapshot has
  `input_tokens = 0`
  ([lib/stores/dashboard-metrics.ts](lib/stores/dashboard-metrics.ts)).

### Changed

- **Context-usage bar visuals.** Bar is now a 3px strip flush along
  the assistant bubble’s bottom edge, clipped by the bubble’s
  rounded corners — no more floating pill below the message. Every
  segment (Hot / Warm / Facts / Overhead slots, reservation tail,
  footer) carries a native tooltip explaining how to read it
  ([components/chat/ContextUsageBar.tsx](components/chat/ContextUsageBar.tsx),
  [components/chat/MessageBubble.tsx](components/chat/MessageBubble.tsx)).
- **Next 16 webpack tracing** aliases `instrumentation-node.ts` to
  `false` for non-Node targets and adds `libsignal` to
  `serverExternalPackages` so the baileys / MCP / sharp graph stops
  leaking into edge and browser bundles
  ([next.config.ts](next.config.ts)).

## [0.9.0] - 2026-06-01

### Added

- **Immutable per-message LLM usage telemetry (ADR-0041).** Each
  assistant turn now snapshots its real provider-reported input /
  output tokens, the provider + model + agent + model-config name in
  effect, AND the pricing rates used to compute its $ cost into a new
  `message_usage` table. The dashboard prefers the snapshot when
  present, so reassigning an agent's model, renaming a model config,
  or refreshing the pricing snapshot no longer rewrites historical
  cost figures. Pre-existing messages without a snapshot keep using
  the content-length estimate as before
  ([docs/adr/0041-immutable-message-usage.md](docs/adr/0041-immutable-message-usage.md),
  [lib/stores/message-usage.ts](lib/stores/message-usage.ts),
  [lib/stores/pricing.ts](lib/stores/pricing.ts),
  [lib/stores/dashboard-metrics.ts](lib/stores/dashboard-metrics.ts)).
- **Clickable token-usage bars.** Bars on the “Token usage over
  time” chart now filter the dashboard breakdown to that day, the
  same as the cost timeline. Click the same bar (or the cost-chart
  clear pill) to restore the window view
  ([components/dashboard/DashboardPanel.tsx](components/dashboard/DashboardPanel.tsx)).

## [0.8.2] - 2026-05-31

### Added

- **Dashboard day drill-down.** Click any day on the “Estimated cost
  over time” chart to narrow the agent / vendor / model breakdown
  pies, the headline metric cards, and the message-count details to
  that day only. Click the same point or the “clear” pill to restore
  the window view; changing the time window resets the selection. The
  selected point gets a larger dot, a pulsing halo and a vertical
  guide; the line and slice animations replay on selection change so
  the eye can re-anchor on the new context. Per-day breakdowns are
  computed server-side (`breakdowns_by_day` on `DashboardMetrics`) so
  the picker is instant
  ([components/dashboard/DashboardPanel.tsx](components/dashboard/DashboardPanel.tsx),
  [lib/stores/dashboard-metrics.ts](lib/stores/dashboard-metrics.ts)).

### Fixed

- **Bridge counterpart replies now speak in the user’s voice.** When an
  agent answers an inbound bridge message from the user’s counterpart
  (1:1 or group), the prompt now instructs the agent to respond on the
  user’s behalf in their voice, following the agent’s persona and
  instructions, instead of introducing itself as an assistant
  ([lib/bridges/message-role.ts](lib/bridges/message-role.ts)).

### Changed

- **Silent-mode framing folded into the bridge prompt envelope.**
  Silent / observer routes used to have a separate `[SILENT_BRIDGE]`
  directive appended after the per-role framing, which could contradict
  the role note (e.g. “respond on the user’s behalf” vs. “never write
  to the chat”). Silent is now a first-class flag on
  `formatBridgePrompt`; when set, the observer-mode note replaces the
  per-role note so the agent sees exactly one framing sentence
  ([lib/bridges/message-role.ts](lib/bridges/message-role.ts),
  [lib/bridges/dispatcher.ts](lib/bridges/dispatcher.ts)).

## [0.8.1] - 2026-05-31

### Added

- **Live action text in app header.** A small label next to the agent
  picker shows what the active agent is doing in real time — `Sending…`
  on submit, `Thinking…` on reasoning deltas, `Using <tool>…` while a
  tool runs, `Responding…` when text streams back — and clears on
  done/error/stop. Replaces the indeterminate top progress strip
  ([components/ui/HeaderActivity.tsx](components/ui/HeaderActivity.tsx),
  [lib/ui/loading.ts](lib/ui/loading.ts), [hooks/useSSE.ts](hooks/useSSE.ts)).
- **Active agent identity in app header.** The header now displays the
  active agent's icon and name next to the picker, falling back to the
  app mark when no agent is selected
  ([components/layout/AppShell.tsx](components/layout/AppShell.tsx)).
- **PWA title-bar theming.** Desktop PWA window chrome and mobile
  browser address bars match the active color theme
  ([app/layout.tsx](app/layout.tsx)).

### Fixed

- Playwright e2e specs aligned with the advanced-mode gating and menu
  reorganization introduced in 0.8.0.

## [0.8.0] - 2026-05-31

### Added

- **Usage & cost analytics dashboard.** New top-level Dashboard panel
  ([components/dashboard/DashboardPanel.tsx](components/dashboard/DashboardPanel.tsx))
  with token/cost overtime charts, segmented sortable pricing and tool views,
  per-model and per-function breakdowns, an interactive donut chart for
  category share, and animated pie/timeline rerenders. Helpers live in
  [lib/dashboard/](lib/dashboard/) with full unit-test coverage.
- **Guided onboarding wizard** ([components/setup/OnboardingWizard.tsx](components/setup/OnboardingWizard.tsx))
  with an inline mode picker (Normal / Advanced) and per-provider capability
  guidance so first-time users land on a working setup quickly.
- **Normal vs. Advanced experience modes.** Centralized mode toggle pill
  ([components/layout/MenuPanel.tsx](components/layout/MenuPanel.tsx)),
  default to Normal mode, mode-aware panel layouts, agent normal-mode
  permission buckets, and an expert toggle inside the model editor.
- **Live pricing extraction** ([lib/pricing/](lib/pricing/)) with an
  LLM-based rate extractor, extraction policy + confidence metadata,
  Google-search fallback when provider pages fail, preference for
  provider-model rates in cost estimates, and a refreshable provider
  pricing snapshot ([docs/journal/pricing-snapshot.json](docs/journal/pricing-snapshot.json)).
- **Currency-aware cost display.** Dashboard converts costs to the user's
  local currency with an Auto/Manual override picker.
- **Humanized cron schedules** on the Scheduled Tasks panel
  ([lib/utils/cron.ts](lib/utils/cron.ts)) — e.g. `0 9 * * 1-5` renders as
  "weekdays at 09:00" next to the raw expression.
- **Per-sub connection counts** (e.g. "4/7") on the Connections panel.

### Changed

- **Connections tab promoted to Common**, Bridges deferred to Advanced; the
  Memory tab now lives behind the Advanced disclosure to reduce first-run
  cognitive load.
- **Centralized model feature-compatibility cues** ([components/models/CapBadges.tsx](components/models/CapBadges.tsx))
  with descriptive tooltips on every capability icon.
- **Centralized system feature-readiness** indicators across surfaces so the
  same readiness signal renders identically in the model picker, agent
  editor, and onboarding wizard.
- **Dashboard panel polish:** sticky controls bar pinned to the scrollport
  with a glass effect, mask on header, donut strokes use `var(--border)`,
  cleaner pricing accents using `var(--accent)`, and consistent control
  ergonomics across all dashboard surfaces.
- **Agent/model row actions** fade in at 40% opacity by default and reach
  full opacity on hover/focus so they are discoverable on desktop without
  scanning the row first.

### Fixed

- **Production boot regression** ([instrumentation.ts](instrumentation.ts) +
  [instrumentation-node.ts](instrumentation-node.ts)). Node-only imports
  (lifecycle/shutdown, tools, triggers, scheduler, exposed-bind warning) are
  now loaded via dynamic `await import()` only when
  `NEXT_RUNTIME === "nodejs"`, fixing a 500-at-boot regression where ESM
  `require` was undefined.
- **Dev-mode service worker** no longer eager-bootstraps the server or
  serves stale chunks.
- **Setup wizard** is now gated behind first-run and no longer reappears
  after profile completion.
- **Profile location display** — collapsed double-encoded UTF-8 bytes
  (`Â·` / `Â±`) back to proper `·` / `±`.
- **Light-mode crypto fallback banner** contrast restored.
- **Dashboard fixes:** sticky controls glass effect, hover-induced control
  resizing, model attribution fallbacks, token chart input/output contrast,
  favorite-tools and model sort options rendering reliably, aliased models
  mapping to pricing rates, small-window cost visibility preserved, donut
  overlap removed.
- **Pricing parsers** correctly detect DeepSeek unit-first token prices and
  Anthropic MTok rates.
- **Agent context handling:** prefix-based permission mapping enforced;
  hot-context truncation on warm fallback miss.

### Refactored

- Pure dashboard helpers extracted into [lib/dashboard/](lib/dashboard/)
  with unit tests.
- Mode-aware UI polish unified across panels; border noise reduced on
  inner elements.
- New shared helpers consolidate widespread duplication:
  [hooks/useEscapeKey.ts](hooks/useEscapeKey.ts) replaces the
  hand-rolled `keydown` listener in 5 modal editors;
  [lib/api/sse.ts](lib/api/sse.ts) centralises Server-Sent Event
  response headers; six API routes adopt `validateBody()` /
  `errorResponse()` / `notFoundResponse()` from
  [lib/api/responses.ts](lib/api/responses.ts) in place of inline
  `req.json()` + `safeParse` boilerplate.

## [0.7.3] - 2026-05-30

### Changed

- **Configuration UI copy clarity improved** across bridge routes, watcher
  reactions, and scheduled-task reactions so option purpose and mode
  differences are visible inline without relying on hover-only hints.
- **README onboarding flow reorganized** with Quick start moved to the top and
  a practical home/work configuration guide that includes tool-chain recipes
  for common goals.

## [0.7.2] - 2026-05-30

### Added

- **First-launch client chunk optimization preflight.** Added
  [scripts/optimize-client-chunks.mjs](scripts/optimize-client-chunks.mjs) and
  integrated it into startup so npm-installed runs can ship scanner-friendly
  readable bundles while optimizing static client chunks locally once on first
  launch. Controlled by `JARELA_PREFLIGHT_OPTIMIZE_CLIENT` and
  `JARELA_FORCE_PREFLIGHT_OPTIMIZE`.

## [0.7.1] - 2026-05-30

### Changed

- **Release npm tarballs now ship readable browser chunks.**
  [next.config.ts](next.config.ts) adds an opt-in
  `JARELA_DISABLE_CLIENT_MINIFICATION=1` mode and
  [release workflow](.github/workflows/release.yml) enables it for npm publish
  builds, reducing false-positive obfuscation/minified-code alerts from
  supply-chain scanners.
- **Runtime dependency surface reduced.** Moved TypeScript and `@types/*`
  packages from runtime dependencies to `devDependencies` in
  [package.json](package.json), trimming non-runtime packages from the
  published dependency graph.

## [0.7.0] - 2026-05-30

### Added

- **Post-turn output validator for safer agent responses**
  ([ADR-0037](docs/adr/0037-post-turn-output-validator.md)). Adds a
  policy-driven validation pass after each agent turn with configurable
  actions for block, warn, and transform paths, plus persistence-backed
  controls for validator behavior.

## [0.6.5] - 2026-05-29

### Added

- **Per-route reply trigger for bridges (`respond_to`).** Bridge routes now
  carry an explicit `respond_to` setting (`"counterpart"` (default) or
  `"user"`) controlling which inbound sender role unlocks an outbound reply.
  The agent always runs on every inbound message so it sees the full
  conversation context — only the reply is gated. `silent_mode` remains the
  master switch (hardwired in the WhatsApp adapter's own `sendText` /
  `sendTyping`) and overrides `respond_to`. Migration adds the column with a
  back-compat default that preserves existing behaviour.
- **Cross-adapter sender-role framing.** New `MessageRole` type and
  [lib/bridges/message-role.ts](lib/bridges/message-role.ts) helper give the
  agent an explicit framing per inbound message (paired user / counterpart /
  group member / agent). The dispatcher prepends a one-line prose framing
  plus a `[message_role:<role>]` tag so the LLM no longer reads every
  inbound chunk as a direct command. Future adapters (Telegram, Slack,
  Discord, mail) just populate `InboundMessage.role` and inherit the
  behaviour.
- **Bridge editor reply-trigger control.** New per-route select in
  [components/bridges/BridgeEditor.tsx](components/bridges/BridgeEditor.tsx)
  with chat-type-aware labels and explanatory subtext; greys out when
  `silent_mode` is on.

### Fixed

- **Streamed thinking line stays visible after the turn finishes.** The
  amber 'thinking…' panel was unmounting on stream `done`, yanking it out
  from under a user mid-read. [hooks/useSSE.ts](hooks/useSSE.ts) now keeps
  the buffered thinking content until the next `start()` / `attach()`, and
  [components/chat/ChatView.tsx](components/chat/ChatView.tsx) passes it to
  `MessageList` whenever non-empty rather than only while streaming.

## [0.6.4] - 2026-05-29

### Fixed

- **Release workflow build failure with optional Baileys fallback.**
  [lib/bridges/whatsapp.ts](lib/bridges/whatsapp.ts) now resolves the legacy
  unscoped `baileys` fallback via runtime `createRequire(...)` instead of a
  literal dynamic import, so Next/TypeScript no longer attempt to resolve an
  uninstalled optional package during CI `next build`.

## [0.6.3] - 2026-05-29

### Changed

- **Lint output made actionable again.** React-Compiler advisory warnings and
  stale `eslint-disable` directives were cleaned up, and
  [components/integrations/NetworkSection.tsx](components/integrations/NetworkSection.tsx)
  was updated to satisfy hook dependency analysis.

### Fixed

- **WhatsApp self-chat context forwarding improved without bot loops.**
  [lib/bridges/whatsapp.ts](lib/bridges/whatsapp.ts) now forwards user-authored
  `fromMe` replies so agents get full local conversation context, while still
  suppressing bridge-authored echoes via sent-message ID tracking.

## [0.6.2] - 2026-05-29

### Changed

- **Baileys dependency hardened and compatibility-preserved.** WhatsApp bridge
  dependency moved from unscoped `baileys` to
  `@whiskeysockets/baileys` in [package.json](package.json), while
  [lib/bridges/whatsapp.ts](lib/bridges/whatsapp.ts) now prefers the scoped
  import with a fallback to the legacy package name for older installs.
- **Standalone external package allowlist updated.**
  [next.config.ts](next.config.ts) now externalizes both scoped and legacy
  Baileys package names to keep standalone tracing and runtime resolution
  stable during migration.
- **Build-only PWA dependencies moved out of production runtime deps.**
  `@serwist/next` and `serwist` were moved to `devDependencies`, reducing
  production dependency surface for installs that consume the published bundle.

### Fixed

- **Cross-platform file-list tests stabilized on Windows.**
  [lib/tools/files.test.ts](lib/tools/files.test.ts) now uses
  `path.basename(...)` instead of slash-splitting paths, making assertions
  robust across path separators.
- **fs-watch skip-dir filtering normalized across separators.**
  [lib/triggers/handlers/fs-watch.ts](lib/triggers/handlers/fs-watch.ts) now
  splits event filenames on both `/` and `\\`, ensuring skip-dir and dot-dir
  filters work on Windows and POSIX-style watcher payloads.
- **Crypto tamper test made deterministic.**
  [lib/crypto/envelope.test.ts](lib/crypto/envelope.test.ts) now mutates
  decoded bytes before re-encoding, avoiding base64url edge cases where
  string-level edits did not always alter authenticated payload bytes.

## [0.6.1] - 2026-05-29

### Changed

- **Supply-chain hardening for standalone server bundles.** Server production
  minification is now disabled and server source maps are enabled in
  [next.config.ts](next.config.ts), reducing obfuscation-style scanner noise in
  generated `route.js`/chunk artifacts while preserving runtime behavior.
- **Standalone dependency externalization expanded.** `undici` is now included
  in `serverExternalPackages` so Next's standalone output avoids rebundling a
  large minified HTTP client chunk family that previously triggered false-positive
  obfuscation alerts.
- **OpenAI-compatible and agent route internals refactored.** Shared parsing and
  mapping logic was deduplicated across providers and API handlers to reduce
  drift risk and tighten maintenance on security-sensitive request/response code.

### Added

- **`link-preview-js` version gate** via
  [scripts/check-link-preview-version.mjs](scripts/check-link-preview-version.mjs)
  and npm script `security:link-preview`, enforcing the patched CVE floor
  (`>= 4.0.1`) whenever the package appears in the lockfile.
- **Route bundle security attestation** via
  [scripts/check-route-bundles.mjs](scripts/check-route-bundles.mjs) and
  npm script `security:routes`, checking generated standalone API route bundles
  for extreme line-length obfuscation signatures, dangerous invocation patterns,
  and missing source maps.
- **Shared tool test harness** in [lib/tools/test-helpers.ts](lib/tools/test-helpers.ts),
  eliminating duplicate fetch/env scaffolding across Atlassian/Jira Align suites.

### Fixed

- **WhatsApp bridge outbound SSRF risk surface reduced.** Outbound message send
  calls in [lib/bridges/whatsapp.ts](lib/bridges/whatsapp.ts) now explicitly
  disable Baileys URL preview resolution (`getUrlInfo: undefined`), preventing
  link-preview fetch paths from executing during normal text sends.
- **Security CI ordering corrected.** The pre-build `security:ci` gate now runs
  only checks that do not depend on build artifacts, while `security:routes`
  runs post-build in [ci workflow](.github/workflows/ci.yml), keeping the gate
  strict and deterministic in clean CI environments.

## [0.6.0] - 2026-05-28

### Changed

- **License switched from MIT to Apache-2.0.** Aligns the project with
  the Apache-2.0 patent grant and contributor terms; users redistributing
  Jarela should review the new `LICENSE` and `NOTICE` requirements.
- **LangGraph checkpointer now uses `node:sqlite` instead of
  `better-sqlite3`** ([ADR-0034](docs/adr/0034-replace-better-sqlite3-checkpointer-with-node-sqlite.md)).
  In-tree `NodeSqliteSaver` replaces `@langchain/langgraph-checkpoint-sqlite`.
  Schema is unchanged so existing `~/.jarela/checkpoints.db` files keep
  working without migration. This drops the EOL `prebuild-install`
  transitive dependency and removes one native module from the
  standalone bundle.
- **Native-module dependencies trimmed.** `keytar` was replaced by
  `@napi-rs/keyring` and `react-syntax-highlighter` by `rehype-highlight`,
  removing two more native build steps from the install path.
  `p-timeout` is now pinned to drop the unused `p-finally` transitive.
- **Chat scroll-to-latest button** moved from the bottom-right corner
  to the top-center of the messages pane so it doesn't overlap the
  composer or follow-up suggestions on narrow viewports.
- **Optimistic user bubble** is now dropped as soon as the persisted
  row arrives over the SSE stream, eliminating the brief duplicate that
  appeared on slow networks.

### Added

- **Agent-driven harness edits via the approval flow
  ([ADR-0036](docs/adr/0036-agent-driven-harness-edits.md)).** Two new
  `propose_config_change` kinds — `upsert_harness` (create/edit a custom
  harness preset) and an extended `update_agent` that accepts
  `harness_id` — let the agent itself propose harness changes. Built-in
  harnesses (`builtin:*`) stay read-only and the global default pointer
  remains UI-only. Approval-time validation rejects unknown harness ids
  and built-in writes before they touch storage. The ApprovalsBanner
  toast now deep-links to `?tab=harness&item=<id>` for the freshly
  created or edited row.
- **Configurable harness presets
  ([ADR-0033](docs/adr/0033-configurable-harness.md)).** The five
  hard-coded harness modules (`capabilities`, `plan_first`,
  `presentation`, `citation`, `self_config`) wrapped around every agent
  turn are now first-class config: a global default pointer plus
  per-agent overrides, with built-in presets and user-authored custom
  presets surfaced in a new Harness settings tab. Existing agents keep
  the previous behaviour by inheriting the default `builtin:default`
  preset.
- **Comprehensive Atlassian + Jira Align coverage
  ([ADR-0035](docs/adr/0035-comprehensive-atlassian-coverage.md)).**
  Adds full Jira Agile coverage (sprints: create / start / complete,
  move issues, rank backlog), worklogs read+add, attachment download
  and delete, issue history/changelog, project metadata (projects,
  versions, components, issue-types, priorities, statuses, version
  release lifecycle), Confluence v2 holes (label CRUD, content
  versions, ancestor walks), and broader Jira Align surface. Routes
  through the same proxy + custom CA bundle as the existing tools.
- **Script-backed reactions and silent muting
  ([ADR-0030](docs/adr/0030-user-defined-watcher-reaction-prompt.md) /
  [ADR-0031](docs/adr/0031-script-backed-watcher-reactions.md) /
  [ADR-0032](docs/adr/0032-script-backed-scheduled-tasks.md)).**
  Watchers now accept a user-defined reaction prompt per watcher
  (replacing the hardcoded "summarise what changed" directive), and
  both watchers and scheduled tasks can choose a `script` reaction kind
  that runs an in-process function with no LLM round-trip — useful for
  notify/log/append-to-memory reactions where the user already knows
  the action. A silent-mute flag suppresses the user-facing notification
  while still firing the reaction.
- **Mail as a configurable indexing source.** Mail sources (Gmail /
  Outlook) are now configurable from the Documents panel like other
  remote sources, including watermark-based incremental sync.
- **Provider and chat UX expansion.** Additional LLM/integration
  providers and chat controls land in the Connections + chat panes
  (model picker affordances, integration card refinements).
- **Inline source attribution** is now mandated in the harness's
  citation section so the agent emits `[ref:…]` markers next to every
  factual claim, reducing hallucination and giving the UI a hook for
  future click-through.
- **Error-report toast.** Browser errors that bubble up to the
  top-level handler now surface as an opt-in toast linking to the bug
  report URL (`NEXT_PUBLIC_APP_ISSUE_URL`), so forks see their own
  issue tracker and upstream users see CircuitWall's.
- **Confluence tool surface expanded** with v2 + v1-fallback coverage
  for spaces, pages, comments, and labels.
- **Anthropic integration card + customizable env-sync allowlist
  (ADR-0034).** The Integrations panel now has a Claude card so the
  Anthropic API key can live in the encrypted store like every other
  credential, and the Anthropic provider's fallback chain reads it before
  `process.env.ANTHROPIC_API_KEY`. Env-sync's default allowlist now
  includes `ANTHROPIC_API_KEY`. Users can also add per-`(integration,
  field)` env-var name aliases via a new "Aliases" editor in the panel
  (or `PUT /api/v1/env-sync/allowlist`) — useful when dotfiles use
  non-canonical names like `MY_GH_PAT`. Defaults always remain; overrides
  are additive.
- **Subprocess credential injection.** `local_exec` shells and stdio MCP
  children now receive every env-sync-managed credential the encrypted
  store has, layered between `process.env` and the explicit per-call /
  per-server env override. Service-mode installs (launchd, systemd,
  brew services) where the launching environment was empty now expose
  the same `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` / `ATLASSIAN_*` /
  `GOOGLE_API_KEY` to subprocesses that the agent itself uses. Per-call
  `env` (for exec) and per-server `spec.env` (for MCP) still win and
  can be set to empty string to unset.

- **Documents tooling parity for local sources**: added
  `documents_add_local_source(path, label?)` so agents can create local
  folder sources directly (with path existence/directory validation), not
  only remote Jira/Confluence/GitHub sources. This closes the previous
  gap where local folders had to be added manually in the Documents UI.

- **Configurable app branding** — three new `NEXT_PUBLIC_*` env vars let
  forks rebrand the user-visible name, description, and bug-report URL
  without patching source. Defaults preserve the upstream "Jarela" branding
  exactly:
  - `NEXT_PUBLIC_APP_NAME` (default `Jarela`) — browser tab title, sidebar
    header, app-shell logo title, welcome screen, and the agent's own
    system prompt (so the LLM stops echoing "Jarela" when running in a
    rebranded fork).
  - `NEXT_PUBLIC_APP_DESCRIPTION` (default `"Jarela — local chat interface
    for LangGraph agents"`) — `<meta name="description">`.
  - `NEXT_PUBLIC_APP_ISSUE_URL` (default
    `https://github.com/CircuitWall/jarela/issues/new`) — the Report-a-bug
    toast target.
  Surfaced via a new `lib/env/app-config.ts` helper module (client-safe)
  and exposed on the cached `getConfig()` object as `appName`,
  `appDescription`, and `issueUrl`.
- **GitHub as a document-RAG source (ADR-0029)**: GitHub joins Jira and
  Confluence as a remote document source, so the same `documents_search`
  tool now retrieves across PRs, issues, and repo files. Two new source
  kinds, both surfaced in the Documents panel and the
  `documents_add_remote_source` tool:
  - `github_pulls` — index every PR of one repo (title + body + issue
    comments + review bodies) as one document per PR. Configurable
    `state` (open/closed/all) and `recency_days`. Watermark is
    max(`updated_at`) so re-runs are incremental.
  - `github_repo` — index text files on one branch of one repo via the
    Git Trees API. Filtered by the same extension allowlist + binary
    heuristic as the local-folder walker. Watermark is the tree SHA, so
    quiet repos cost a single API call per scheduler tick.
  `documents_index_url` now also recognises `/pull/<n>`, `/issues/<n>`,
  and `/blob/<ref>/<path>` URLs and stores the result under the same
  shared on-demand source as Jira/Confluence URL captures.
- **GitHub tools — full read/write surface**: the GitHub integration grew
  from 7 tools to 19, so the agent no longer has to fall back to the `gh`
  CLI for the common write workflows (which is the whole reason these
  tools exist on locked-down corp laptops). New tools cover:
  - Issues: `github_update_issue` (close / reopen / edit / re-label),
    `github_list_issue_comments`.
  - Pull requests: `github_create_pull`, `github_update_pull`,
    `github_merge_pull` (merge / squash / rebase, optional `sha` guard
    against force-pushes), `github_request_reviewers`,
    `github_create_review` (approve / request changes / comment),
    `github_list_pull_files` (with truncated patches),
    `github_list_pull_reviews`.
  - Repo content: `github_list_branches`, `github_get_file` (UTF-8 decode
    + binary detection + 20 KB cap), `github_search_code` (with code
    snippets via `text-match` Accept header).
  All tools route through the same `ghFetch` wrapper as before, so the
  in-app HTTP proxy and custom CA bundle continue to apply.

## [0.5.1] - 2026-05-27

### Changed

- **Docs**: refreshed the current-facing install and UI docs to match the
  shipped product. README / INSTALL / ARCHITECTURE now reflect the
  Connections tab rename, the split between Connections and Tools, Next.js 16,
  the platform-specific Windows data dir, and the scoped npm package name
  `@circuitwall/jarela` for install / update / uninstall commands.
- **npm distribution**: the published package now includes a prebuilt
  `.next/standalone` bundle so `npm install -g @circuitwall/jarela`
  starts immediately instead of trying to compile inside `node_modules`.

### Fixed

- **Windows task runner**: `make install` now passes npm arguments reliably.
  The PowerShell helper no longer collides with the automatic `$args`
  variable, so `Invoke-Npm` actually runs `npm install` / `npm run …`
  instead of invoking bare `npm` with an empty argument list.
- **npm-installed startup**: `jarela start` no longer attempts a Next build
  from a global `node_modules` path. If a packaged standalone bundle is
  missing, the CLI now fails fast with a clear packaging error instead of
  falling into an unrecoverable webpack parse failure.

## [0.5.0] - 2026-05-26

### Added

- **Documents — remote sources (Jira & Confluence)**: alongside local
  folders, the Documents tab now indexes Atlassian content directly.
  Pick a kind (Confluence space, Confluence CQL, Jira project, Jira
  JQL), supply the key/query, and the existing scheduler chunks +
  embeds the matching pages/issues into the same `documents_search`
  surface as local files. Auth reuses the Atlassian Connections entry
  — no second credential prompt. See
  [ADR-0026](./docs/adr/0026-remote-document-sources.md).
- **Documents — folder picker**: the local-folder source form now uses
  a native directory picker instead of a free-text path field, so the
  user no longer has to type `/Users/…` paths or remember escaping
  rules.
- **Documents — watcher-driven re-indexing**: local sources now
  re-index in ~1 s after a file change instead of waiting for the
  10-minute sweep, via `fs.watch` with a 500 ms debounce. Atlassian
  remote sources poll on a 60 s fast-sweep cadence. Built on a new
  scripted-trigger primitive (the trigger abstraction now fires either
  agent prompts or in-process scripts; deletions and missed events
  are still backstopped by the existing 10-min full sweep). See
  [ADR-0027](./docs/adr/0027-event-driven-watchers.md) and
  [ADR-0028](./docs/adr/0028-scripted-trigger-firings.md).
- **Watcher tasks**: event-driven companion to scheduled tasks. A
  watcher polls a single built-in tool every N seconds and only
  invokes the agent when the tool's output changes since the previous
  poll — useful for "ping me when this PR list changes" without
  cron-style polling churn. Watcher firings are tagged
  `category="watcher"` so they're filterable in the chat-panel
  toolbar. See ADR-0027.
- **Chat filter — watcher channel**: the chat-panel category toolbar
  now exposes a `watcher` chip alongside `scheduled`, `bridge`, and
  `captures`, so the operator can hide watcher-fired messages without
  affecting other automation.
- **Connections tab**: a single home for every auth surface. The old
  "Credentials" tab is renamed to "Connections" and gains a sub-tab
  for MCP server credentials, which previously lived under Tools.
  Result: one mental model — *Connections* for "what accounts has
  this been given access to", *Tools* for "what can the agent do".
  Deep links update: `?tab=integrations` becomes `?tab=connections`
  (the in-app proposal banners are auto-rewritten; external bookmarks
  to the old slug stop resolving).
- **Built-in tool toggles**: a new "Built-in" sub-tab under Tools
  lets the operator enable or disable whole categories of shipped
  tools (Memory, Files, Web, Shell, Mail, Calendar, …). Disabled
  categories disappear from the agent permission editor AND are
  blocked from invocation at runtime, so an older agent that still
  has them in its allow-list cannot reach them. Default-enabled
  semantics: existing installs see no change. First step of the
  Connections consolidation (see follow-up stages).
- **Documents**: index any folder on disk for semantic recall. The
  new Documents tab lets the user point Jarela at one or more
  folders; text files (markdown, code, configs, plain text) are
  chunked, embedded with the configured model, and surfaced to
  agents via the `documents_search` tool. Reindex runs automatically
  every ~10 minutes from the scheduler; the panel offers per-source
  `Reindex now`, enable/disable, and a preview-search input.
  Embedding failures gracefully degrade to substring matching so
  installations without an embedding provider still get useful
  results. See [ADR-0024](./docs/adr/0024-document-rag.md).
- **External tools**: encrypted secret slots. Tools loaded from
  `~/.jarela/tools/` may declare a `secrets: [{ key, label?, required?,
  description? }]` array; values are persisted in the `tool-secrets` memory
  namespace, AES-256-GCM enveloped at rest like the integrations store, and
  surfaced to the tool at run time via `ctx.getSecret(key)`. The Extensions
  panel renders an "Edit" form per tool with the standard masked sentinel
  pattern (plaintext never reaches the client). See
  [ADR-0023](./docs/adr/0023-external-tool-secrets.md).

### Changed

- **Trigger abstraction**: scheduled tasks and the new watcher tasks
  now share a single `TriggerHandler` interface, and a generic
  `change_tracker` store records the "last seen" hash that watchers
  diff against. Pure refactor — no behavioural change for existing
  scheduled tasks. Lays the groundwork for additional trigger kinds
  (file-system, webhook, MQTT). See
  [ADR-0025](./docs/adr/0025-trigger-abstraction-and-change-tracker.md).

### Fixed

- **E2E**: the watcher e2e is now skipped on Linux runners — Node's
  recursive `fs.watch` is unsupported there and the spec relied on it.
  CI is green again on the GitHub-hosted Linux matrix; macOS / Windows
  still exercise the full watcher path.

### Internal

- **Lint**: ESLint now enforces the `node:` prefix on every Node
  builtin import (`fs`, `path`, `crypto`, …) and the codebase has been
  migrated. Required for Next.js's edge-runtime path resolution; the
  `no-restricted-imports` rule prevents regressions.

### Breaking changes (#39, pre-1.0 → MINOR per CONTRIBUTING.md)

- The `?tab=integrations` deep link is removed in favour of
  `?tab=connections`. In-app proposal banners are auto-rewritten;
  external bookmarks to the old slug stop resolving.
- The `tools` category for MCP-server credentials moves under
  Connections → MCP. Any external tooling that screen-scraped the
  Tools tab for MCP credential UI will need to follow the new path.

## [0.4.0] - 2026-05-25

### Added

- **Browser extension**: configurable Jarela endpoint. The extension
  options page now exposes the scheme (`http`/`https`), host, and
  port the popup launches into, so users running Jarela on a custom
  port (or behind a Tailscale-Serve hostname) no longer have to live
  with the hardcoded `http://127.0.0.1:4312`. Clicking the extension
  icon when Jarela isn't reachable opens the options page instead of
  silently failing. When the page is reachable, the extension
  prefers launching the installed PWA over a normal tab (#28).
- **Jira tool**: `jira_get_issue` now accepts an
  `include_comments` flag so the agent can pull issue conversation
  history in one call without a follow-up `jira_get_comments` round
  trip (#32).
- **Profile**: persona preset (Home / Work / Developer / Everything).
  The picker lives in the Profile editor and drives a new category
  filter on the Credentials panel so first-run users aren't faced
  with eight unrelated integration cards. Existing installs keep
  today's "show everything" behaviour until they pick a preset.
  Schema: `user_profile.preset TEXT NULL` (auto-migrated; `NULL` =
  no filter).
- **Tools**: new top-level menu entry that bundles **MCP servers**
  and **Browser extensions** behind a single nav label with inline
  sub-tabs. Cuts the menu from 10 entries to 9 and clusters the two
  "extend what the agent can do" surfaces together.
- **Credentials**: each integration definition now exposes a
  `category` (`llm` | `mail` | `calendar` | `issue-tracker` | `chat` |
  `infrastructure` | `other`) over the API. Already-configured
  credentials are never hidden by the persona filter even when their
  category is outside the active preset.
- **Memory panel**: list items now render a typed, compact summary of
  each entry instead of a single-line `JSON.stringify`. Objects show
  the first few `key: value` chips with a "+N more" tail; arrays show
  their length and first elements; multi-line strings get a small
  scrollable `<pre>`. A chevron toggles a pretty-printed expansion of
  the full value. Token-shaped fields (`*_token`, `*_secret`,
  `api_key`, `password`, …) are masked at every nesting level, so
  glancing at the panel can't leak credentials.

### Changed

- **Menu**: the agent menu is now split into a top "common" row
  (Chat, Agents, Memory, Tasks, Bridges, Profile) and a collapsible
  "Advanced" section (Credentials, Models, Tools). The collapsed
  state is persisted in `localStorage` (`jarela.menu.advanced`) and
  auto-opens when navigating into an Advanced tab via deep-link.

### Fixed

- **Chat (mobile)**: the "Play voice" button on assistant bubbles
  is now visible on touch devices. It was gated behind
  `group-hover:opacity-100` with no fallback, so iOS Safari and the
  installed PWA rendered it invisibly. Same fix applied to the row-
  action toolbars in the MCP, Memory, Models, and Sidebar panels,
  plus the toast dismiss button (#33, #34).
- **Chat**: stopping a streaming run now restores the input bar
  cleanly. Previously the Stop button could leave the UI in a half-
  streaming state where Send was disabled until the next refetch
  (#31).
- **Build**: regenerated `package-lock.json` against the public npm
  registry. A previous lockfile regeneration was done on a machine
  with a private mirror configured, leaking 84 internal-only
  resolved URLs into the lockfile and breaking CI / Docker builds
  for anyone without access to that mirror (`Cannot find module
  '../lightningcss.linux-x64-gnu.node'` during `next build`) (#29).

### Build

- Project now ships a committed `.npmrc` that pins
  `https://registry.npmjs.org/` so contributors with a private mirror
  in `~/.npmrc` no longer leak internal URLs into the lockfile. The
  `Dockerfile` and CI workflow set `--registry` explicitly as belt-
  and-braces. CI also gained a sub-second tripwire that fails the
  build if `package-lock.json` ever contains a non-public resolved
  URL again (#30).

### Security

- `web_fetch` now refuses to call loopback, RFC1918, link-local, and
  cloud-metadata (`169.254.169.254`) addresses. A prompt-injected page
  could previously coax the agent into fetching
  `http://127.0.0.1:4312/api/v1/...`, which the auth middleware treats
  as the host's admin user (full unauthenticated access). Each
  redirect hop is re-checked against the same policy. Operators with
  a legitimate intranet target can opt back in with
  `JARELA_ALLOW_PRIVATE_FETCH=1`.
- The `file_*` agent tools now refuse to touch credential trees
  (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.kube`,
  `~/.docker`, `~/.netrc`, `~/.pgpass`) and any path whose basename
  looks like a private key (`id_rsa`, `*.pem`, `*.key`,
  `credentials`). Writes/edits/moves/deletes into Jarela's own data
  dir (`~/.jarela`) are blocked too so prompt injection can't rewrite
  app state. Override with `JARELA_ALLOW_SENSITIVE_FILES=1`.
- WhatsApp bridge now sanitises inbound media `mimetype` against a
  per-kind allowlist (image/audio/video/document) and rejects anything
  that doesn't match the `type/subtype` RFC 6838 shape, instead of
  trusting whatever the sender claimed.
- The Next.js server now logs a prominent warning at boot if it is
  bound to a non-loopback interface outside a container, since the
  `Tailscale-User-Login` header it relies on for authentication is
  trivially forgeable on the LAN without a Tailscale-Serve (or
  equivalent) reverse proxy in front. Suppress with
  `JARELA_ALLOW_NONLOOPBACK_BIND=1`.

## [0.3.0] - 2026-05-24

### Added

- Chat bubble now renders inbound bridge media inline: audio messages use
  an `<audio controls>` player and video messages use a `<video controls>`
  player, so voice notes and short clips from WhatsApp can be reviewed
  without downloading the attachment (#20).

### Changed

- Bridge notification titles now read `Sender → Agent` (with a
  `(group)` suffix for group chats) instead of just the chat name, so
  operators can see who is talking to which agent from the toast alone
  (#20).

## [0.2.1] - 2026-05-24

### Fixed

- MCP registry picker no longer renders the same server multiple times.
  The upstream registry returns one row per published version, and the
  picker was only filtering by `status == "active"`. It now filters by
  `_meta.isLatest` (treating a missing flag as latest so newly-published
  servers still surface) and dedupes by fully-qualified upstream name
  plus `(id, transport)` install identity (#14).
- MCP registry picker no longer surfaces community entries labelled as
  "Vendor". The `com.<vendor>/` namespace is now matched against an
  allowlist mirroring `VENDOR_GITHUB_ORGS`; any unrecognised
  domain-verified namespace falls back to `Community` and is filtered
  out by default (#14).

## [0.2.0] - 2026-05-24

### Added

- WhatsApp bridge forwards inbound media (images, audio, video, documents)
  to vision-capable agents, and the bridge editor now surfaces a
  vision-capable hint per agent so operators can pick a compatible model
  (#11).
- MCP picker shows only verified upstream servers and ranks them by
  popularity (#8).
- Opt-in mock LLM provider (`JARELA_ENABLE_MOCK_PROVIDER=1`) for
  deterministic offline development and CI, plus a Playwright E2E suite
  driven entirely by the mock provider — no real LLM keys required (#5,
  #6).
- Experimental `main` update channel and an in-app update notice with a
  `jarela update` CLI command for one-shot self-updates (#1, #4).
- README hero video promoting the demo above the "what is Jarela"
  section (#9, #10).

### Fixed

- Chat filter toolbar no longer gets stranded by the iOS PWA bounce — it
  is now pinned to the top of the viewport (#2).
- Menu tray pin behaviour on small viewports (#3).
- Playwright `chat-mock` smoke test uses a unique marker per run and
  asserts on `.last()` so it no longer trips strict-mode locator
  resolution when the shared SQLite DB at `JARELA_DB_DIR=/tmp/jarela-e2e`
  accumulates messages across the `chromium-desktop` and `mobile-safari`
  projects (#7, #12).

## [0.1.3] - 2026-05-24

### Changed

- Verify CI release path end-to-end via npm Trusted Publisher (OIDC).
  No functional code changes vs. 0.1.2; this version exists to confirm
  that tagged releases publish to npm with provenance attestations
  signed by GitHub Actions, without any long-lived `NPM_TOKEN`.

## [0.1.2] - 2026-05-24

First public release.

### Added

- Docker support: multi-stage `Dockerfile`, `docker-compose.yml`, and a
  `release-docker.mjs` helper that builds and pushes multi-arch images
  (`linux/amd64`, `linux/arm64`) to Docker Hub as
  [`andrewgewu/jarela`](https://hub.docker.com/r/andrewgewu/jarela).
- CI `docker-publish` job in `.github/workflows/release.yml`, gated by the
  `JARELA_DOCKER_PUBLISH` repo variable and `DOCKERHUB_USERNAME` /
  `DOCKERHUB_TOKEN` secrets.
- `LICENSE` (MIT), `CHANGELOG.md`, and `.nvmrc` so the package is publishable
  to npm and the registry surfaces correct license metadata.
- Published to npm under the
  [`@circuitwall`](https://www.npmjs.com/org/circuitwall) org as
  [`@circuitwall/jarela`](https://www.npmjs.com/package/@circuitwall/jarela).
- `package.json` metadata: `repository`, `author`, `keywords`, `homepage`,
  and `bugs`.
- Per-agent message-channel display filters (ADR-0022). Users can hide
  `scheduled_task`, `bridge`, `synthetic`, `tool_use`, and `thinking`
  messages on a per-agent basis; settings are persisted server-side.
- `never_reply` flag on agent configs — agents can observe bridge/scheduled
  input without auto-responding until directly addressed.

### Changed

- Default Docker repo flipped from `jarela/jarela` to `andrewgewu/jarela` in
  the release script, the workflow's `JARELA_DOCKER_REPO` fallback, and the
  install docs.
- `Coder` starter agent profile renamed to `Developer`, with tightened
  instructions (verify every edit via `shell_exec` build/lint/test) and an
  expanded toolset (`shell_exec`, `local_exec`, `web_search`, `web_fetch`,
  `github_*`, `memory_*`).

### Fixed

- Release workflow: `INSTALL.md` is now copied from `docs/INSTALL.md`; the
  previous v0.1.1 attempt failed because the file path was wrong.
- Chat: category filter toolbar no longer disappears on the PWA. It was
  rendered inside a scroll container with a top/bottom transparency-fade
  mask that swallowed the ~26 px chip row.
- UI: debounce health-check failures so long agent turns no longer flash an
  "offline" indicator mid-stream.

## [0.1.1] - 2026-05-23

Internal beta. Docker image `andrewgewu/jarela:0.1.1` was published, but the
GitHub Release workflow failed (broken `INSTALL.md` path); superseded by
0.1.2.

## [0.1.0] - 2026-05-23

Initial Docker Hub publication: `andrewgewu/jarela:0.1.0` (multi-arch).
