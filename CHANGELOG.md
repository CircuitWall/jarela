# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.2] - 2026-06-03

### Fixed

- **Stall-retry now catches in-turn duplicate-tool-call loops.** The
  existing detector required zero tool calls in the turn before
  retrying, so a model that kept calling the same read-only tool over
  and over (e.g. `file_read` on the same path 14 times while announcing
  "writing now") slipped through. We now also flag a turn when any
  `(tool, args)` signature recurs ≥ 3 times within the turn, abort the
  inner stream, and inject a loop-aware nudge ("you called X 3+ times
  with the same arguments without making progress — invoke a different
  tool or stop"). A `console.warn` records the looped tool/thread so
  future occurrences leave a fingerprint identifying the provider.
- **Hardcoded known-rates fallback for canonical model ids.** When the
  live pricing snapshot loses data (anthropic page redesign zeroed every
  `model_rates` entry; LLM/regex extractor returning uniform garbage for
  openai), the `byProvider` / `byProviderModel` / `byModel` lookups all
  fall through to a null rate and the dashboard cost columns silently go
  blank. New table at `lib/stores/known-rates.ts` lists authoritative
  per-1M-token rates for the canonical Anthropic / OpenAI / Google /
  DeepSeek / Cohere model ids, consulted as a 4th tier after the
  snapshot lookups. Snapshot still wins when present; the table is
  stale-by-design and reports `confidence: "medium"`. Catches the
  real-world failure where `(provider=visa, model=claude-opus-4-7)`
  produced $0 cost because anthropic's snapshot source had no
  `model_rates`.
- **Pricing lookup for aggregator-namespaced model ids.** Models exposed
  by aggregators (OpenRouter / LiteLLM style) carry a `vendor/model` or
  `aggregator/vendor/model` prefix, which the pricing snapshot doesn't
  store. The byModel fallback now also tries the bare suffix, and the
  github-copilot upstream-inference path strips the prefix before
  matching, so e.g. `openai/gpt-4o` resolves to OpenAI's published
  `gpt-4o` rate instead of falling through to a null provider rate.
- **Inbound channel cue in the agent system prompt
  ([#151](https://github.com/CircuitWall/jarela/pull/151), ADR-0061).**
  Non-chat turns (scheduler, watcher, bridge) now carry an active-turn
  channel cue so the LLM treats the body inside the inbound envelope as
  the active request. Previously, in mixed-source threads, the agent's
  reply could ignore the inbound's content and respond as if the latest
  chat turn were still active. `ThreadRunRequest.silent` replaces the
  old `[SILENT_TRIGGER] … NO_REPLY …` body wrapper so the LLM no longer
  sees two competing copies of the rule.

### Documentation

- **Design principles & scope boundaries
  ([#152](https://github.com/CircuitWall/jarela/pull/152)).** Adds an
  explicit list of the 12 load-bearing architectural rules
  (local-first, single process, single port, capability axis,
  human-in-the-loop, …) and an in-scope/out-of-scope table to
  `docs/ARCHITECTURE.md`, with cross-refs to the ADRs that codify each
  one. README links to the new section.

## [0.11.1] - 2026-06-03

### Fixed

- **Drop orphaned checkpoint rows when a thread is deleted.**
  `DELETE /api/v1/threads/{id}` now also calls
  `getCheckpointer().deleteThread(id)` so the thread's LangGraph rows
  in `checkpoints.db` are reclaimed. The per-turn wipe in
  `lib/agents/llm.ts` only ran for active threads, so deleted threads
  left their checkpoint rows orphaned forever and `checkpoints.db`
  grew monotonically with thread deletions.

## [0.11.0] - 2026-06-03

### Added

- **`workspace_context` tool: one-shot codebase bundle for the developer
  agent.** Returns a curated snapshot (directory tree, git status,
  `package.json` summary, README excerpt, optional grep hits) so the
  agent can ground answers without burning turns on filesystem probes.

### Fixed

- **OpenAI-compatible adapters now emit stream usage events.** Both
  `lib/providers/openai.ts` and `lib/providers/github-copilot.ts` send
  `stream_options: { include_usage: true }` and yield a `usage` chunk
  from `chunk.usage`, so ADR-0041 token accounting reflects real
  provider counts instead of estimates.
- **Cap warm-summary chat with a wall-clock deadline.** Adds
  `SummaryTimeoutError` and a 25s default deadline around the summary
  stream loop, threaded through `summarizeTranscriptWithRetry`. Prevents
  a stuck warm-summary call from starving the run-registry idle
  watchdog and silently hanging a run.

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
