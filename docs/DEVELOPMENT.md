# Development workflow

This guide focuses on developer experience for UI/state work.

## Quick commands

- Install: `npm install`
- Lint all: `npm run lint`
- Lint hooks only: `npm run lint:hooks`
- Test all: `npm test`
- Test hooks only: `npm run test:hooks`
- Watch hook tests: `npm run test:hooks:watch`

## Documentation history chart

`npm run docs:build` regenerates the [project history chart](PROJECT_HISTORY.md)
before building the Zensical site. `npm run docs:dev` generates the same snapshot
before serving; restart it or run `npm run docs:history` to refresh after commits.
The standalone generator uses Node and Git only and writes the ignored
`docs/assets/project-history.html`; do not commit generated history snapshots.
The source is `scripts/generate-project-history.mjs` with
`scripts/project-history.template.html`.

Use a full Git checkout with tags. For a shallow clone, run
`git fetch --unshallow --tags`; otherwise fetch missing tags with `git fetch --tags`.
The generator rejects shallow history, validates line totals against Git
shortstats, and publishes only numeric statistics, types, dates, abbreviated
hashes and reachable app version tags. It does not publish commit subjects,
author details, file paths or editorial interpretation. The deployment workflow
checks out full history and tags and rebuilds on main pushes or manual dispatch.
Tag-only pushes do not trigger deployment.

Validate changes with
`npx vitest run scripts/generate-project-history.test.mjs` and
`npm run docs:build`. The chart is a static build artifact, separate from app
runtime state; it adds no provider or network dependency.

## Shared workspace layout (unreleased)

Workspace sizing is owned by the CSS tokens in
[`app/globals.css`](../app/globals.css):

- `--workspace-content-max-width`: `none` by default, shared by
  `.workspace-content` and `.workspace-panel`.
- `--workspace-gutter`: `1rem`, applied by `.workspace-gutter` to outer
  content, panel headers, and sub-tab strips. Keep vertical spacing local.
- `--workspace-navigation-width`: `20rem`, shared by the docked right menu,
  shell reservation, and toast offset.
- `--workspace-agents-width`: `16rem`, shared by the docked left agent
  sidebar and shell reservation.

Use the shared classes rather than adding panel-specific maximum widths or
outer horizontal padding. Nested cards, dialogs, chat bubbles, and standalone
onboarding content retain their own sizing. The touch composer retains its
safe-area-specific inset for rounded-corner clearance.

[`tests/e2e/layout.spec.ts`](../tests/e2e/layout.spec.ts) checks mobile bounds,
wide-screen panel widths and gutters, progressive sidebar docking, and token
overrides. Its server uses an isolated database; never run fixture-writing
tests against a contributor's regular instance.

## SQLite statement reuse

Repeated thread/history reads use `cachedRead(db, sql)` from
[`lib/db/statement-cache.ts`](../lib/db/statement-cache.ts). It retains at most
128 prepared statements per connection with least-recently-used eviction.
Parameters are bound for every read; rows are never cached, so writes and
transaction rollbacks remain visible. Exact SQL text is the cache key; keep
user values in placeholders, not interpolated into SQL.

Use only immediate synchronous `get`/`all` calls. Do not mutate statement
settings or retain iterators on shared statements. Other database callers and
migrations continue to use ordinary `prepare`. The cache drops references on
eviction, before migrations, and database shutdown; SQLite statements are reclaimed by garbage
collection or connection close on the supported runtimes. It uses the shared
Node 24/26 prepared-statement API rather than a version-specific
`SQLTagStore` helper, so the cache works on both supported Node lines.
Direct schema-changing code must call `clearStatementCache(db)` before the next
cached read: reused statements can retain outdated `SELECT *` column metadata.

Validate changes with `npx vitest run lib/db lib/stores/threads.test.ts` on both
supported Node lines. Cache tests cover reuse, fresh bindings/data, connection
isolation, LRU bounds, schema changes, rollback, and explicit errors.

## Mobile PWA chrome

Touch devices, viewports below 768 CSS pixels, and standalone/fullscreen PWAs use
an opaque, theme-aware header so scrolling content and the ambient background
do not haze navigation or the status-bar safe area. The rule does not depend
solely on pointer capabilities. Wide desktop browser tabs retain the selected
glass treatment; the filter banner and composer retain their frost separately.

Filters & focus uses a flat, full-width frosted-glass banner below the header,
rather than a floating pill. Its 60%-opaque surface and moderate backdrop blur
keep the controls readable without an elevated card treatment. Below 640 CSS
pixels its expanded controls form a two-column grid with 44-pixel minimum
targets. The expanded area scrolls within 35% of the
viewport height so it does not displace the conversation on short screens.

The chat composer shares the banner's 60%-opaque surface and moderate blur.
Both panels overlay the message scroll viewport, so older turns scroll behind
their frost. Resize observers measure the filter banner and the complete bottom
controls stack (including approval/error banners). The measured bottom height is
exposed as `--chat-controls-height` on the message-list container; content padding,
scroll padding, and the resume-scroll button all use that variable plus `1rem`.
Matching content and scroll padding keeps the first turn below the filter
banner and new/streaming turns above the composer when following the latest
message. Measurements update when
filters expand, attachments appear, the textarea grows, or the viewport changes.
Focus-boundary dragging and the resume-scroll button use the unobscured area.

The chat composer trades 16 CSS pixels of the bottom safe-area inset for
horizontal corner clearance (12-24 CSS pixels per side, in addition to the
shell's landscape cutout insets). It retains at least 8 CSS pixels below the
44-pixel controls; a 34-pixel home-indicator inset therefore leaves 18 pixels,
not a full 34-pixel chin. Do not just remove bottom padding or move the send
button against the screen edge.

The mobile chrome cases in `tests/e2e/layout.spec.ts` check compact spacing,
rounded-corner clearance, theme/surface variants, and a keyboard-sized viewport.
Browser emulation supplies synthetic safe-area values; also check an installed
iOS PWA on hardware for OS-specific compositing and keyboard behavior.

## Live-test setup

`npm run test:live` targets the server at `JARELA_URL` (default
`http://localhost:4312`). Use an isolated server and `JARELA_DB_DIR` for test
runs: the suite writes fixtures through the public API.

Before running checks, the suite ensures a default model and agent exist and
verifies that their binding persisted. It reuses configured records and creates
fixtures only when the corresponding list is empty; fresh installs intentionally
have no application-seeded agents. Setup errors stop the run before dependent
checks execute. CI runs this live-test prerequisite before the Playwright suite.
Production credential import remains opt-in via `JARELA_SEED_FROM_PROD=1`.

### Previously skipped checks

The Playwright configuration starts an isolated production server and database.
Run `npm run build` first, then `npx playwright test` for the configured desktop
Chromium and mobile WebKit projects. Dashboard sorting uses synthetic multi-model,
multi-provider data; focus-boundary pointer checks run in both projects.

Native document-watcher checks default to macOS because event delivery is
platform/load dependent. To exercise the actual watcher pipeline on Windows
or another host explicitly, set `JARELA_E2E_NATIVE_WATCHER=1` and run
`npx playwright test documents-watcher.spec.ts --project=chromium-desktop`.
This opt-in does not replace failures with skips or certify other operating systems.

The local embedding benchmark is also opt-in: set
`JARELA_BENCHMARK_EMBEDDINGS=1` and run
`npx vitest run lib/embeddings/performance.test.ts`.
It requires the installed local model, forbids remote providers and downloads,
and measures synthetic latency rather than retrieval quality. The linked-leaf
skill-resource test remains unavailable on Windows without file-symlink creation
privileges; directory-junction coverage is separate from that check.

## Git and PR conventions

[CONTRIBUTING.md](../CONTRIBUTING.md) is the source of truth. Do not drift
from it when creating commits, branches, or PRs.

- Work on a topic branch, never local `main`.
- Use Conventional Commits v1.0.0 with required scope: `type(scope)[!]: description`.
- Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`.
- Keep the full subject at 72 characters or less.
- Start the description with a real lowercase imperative verb, with no trailing
  period and no parenthesized asides.
- PR titles must follow the same format, and so must every commit on the
  branch: rebase merge replays them all onto `main` individually.
- Do not carry lint warnings forward; fix warnings in touched workflows before
  committing.
- Local hooks enforce branch and commit-message format. CI enforces pull request
  titles and post-merge commit subjects.

## Hook API conventions

- Prefer the unified contract in [docs/ui-hook-api.md](./ui-hook-api.md):
  `state + commands` as canonical surface.
- Keep backward-compatible flat fields during migrations.
- New hook tests should verify:
  - `state` and `commands` shape
  - flat-field parity
  - one async/event path

## File naming and packaging

- Hooks: [hooks/](../hooks/) as `use{Name}.ts`
- Hook tests: [hooks/](../hooks/) as `use{Name}.test.ts`
- Keep hook tests in `hooks/`, not `components/`
- Use `.tsx` only if JSX is required by the test

## Tool directory standard

Keep `lib/tools/` as a small public entrypoint, not a dumping ground for every
tool and helper. New tool code belongs in the narrowest domain folder below:

```text
lib/tools/
  index.ts                  # stable public facade
  communications/           # Gmail, Outlook, Calendar, Microsoft Graph, To Do
  delegation/               # agent, Claude Code, and Codex delegation
  filesystem/               # files, file search, outlines, workspace context
  general/                  # standalone built-in tools without a narrower domain
  packages/                 # LangChain package loading, manifests, install, allowlist
  runtime/                  # registry, catalog, built-in registration, public tool types
  security/                 # safety gates, subprocess environment, credential context
  support/                  # async results, result references, wallclock, Git helpers
  system/                   # tool listing, proposals, skills, MCP and system tools
  web/                      # browser, fetch, search, shopping, media generation
  core/                     # catalog/runtime aggregation facade
```

### Placement rules

- Put a new agent-callable tool beside the closest existing domain. Use
  `general/` only when no more specific domain applies.
- Put a tool's tests beside its implementation in the same domain folder.
- Put registration and discovery logic in `runtime/`; do not put it in a tool
  implementation folder.
- Put reusable cross-domain mechanics in `support/` or `security/`, not in a
  domain tool file.
- Add built-in side-effect imports to `runtime/builtins.ts`, grouped in the
  same domain order as the folders above.
- Keep `lib/tools/index.ts` as the compatibility/public facade. Update it only
  when a public export or shared type needs to be exposed.
- Do not create one-line re-export stubs in the old root location. Update
  internal imports to the real domain path instead.
- Preserve public package subpaths such as `@circuitwall/jarela/lib/tools/types`
  by updating their `package.json#exports` target when an implementation moves.

When adding a new folder, keep its direct file count readable. Split a domain
again when it starts mixing unrelated responsibilities, rather than allowing
another large flat directory to form.

## Tool-history retrieval (unreleased)

The dynamic system-prompt suffix retrieves local tool history before the model
chooses calls for a turn. It reuses `lib/stores/tool-stats.ts`; no embeddings,
new schema, external service, or extra model call is required.

Exact keyword overlap between the task and allowed tool names selects up to
eight tools, ranked by matching word count. Without a match, retrieval falls
back to the allowed tools. The prompt includes at most three reliable-tool
summaries, five recovery hints, and three recurring failure patterns. Tools
must have been called within 30 days; their success counts are lifetime
aggregates, not a rolling success rate. Failure patterns require at least two
observations and a last observation within 30 days; expected skips are excluded.
The SQL lookup returns only tool names, normalized categories, and counts,
never stored error samples or argument shapes.

These are advisory signals, not verified correction examples or permission
changes. Current tool schemas and permissions remain authoritative; successful
execution does not establish task completion, and timed-out writes need outcome
verification before retrying. Retrieval runs once during turn preparation, not
again before every call in a multi-call turn.

Validate with `npx vitest run lib/stores/tool-stats.test.ts lib/agents/prepare/system-prompt.test.ts`.

## Safe migration pattern

1. Add `state` + `commands` without removing old flat fields.
2. Update/introduce contract test under [hooks/](../hooks/).
3. Migrate callers to `state`/`commands` incrementally.
4. Remove legacy fields only after deprecation window and docs update.

## Known limits

- Browser-only hooks can depend on `window`, `navigator`, `Notification`,
  and `EventSource`; test under jsdom.
- Event-driven hooks are eventually consistent; prefer deterministic asserts
  (`waitFor`) over synchronous assumptions.

## LLM provider rate limiting

`getProvider()` applies a process-wide `p-queue` limiter to chat, structured
invocations, streaming invocations, and embeddings. All agents, model configs,
and credentials for a provider share its budget. Requests are evenly paced;
concurrency slots remain held until active requests or streams actually settle,
including when cancellation is requested.
Catalog discovery is not counted as model inference. Unknown providers and the
mock provider are unlimited unless overridden. LangChain's `ChatCohere` uses
the Cohere budget.

| Provider | Requests/minute | Concurrent requests | Default basis |
| --- | --- | --- | --- |
| Anthropic | 1,000 | Unlimited | Published standard Start tier; Evaluation tier can be lower |
| OpenAI | 60 | Unlimited | Conservative application preset; limits vary by model/project/tier |
| Gemini | 5 | Unlimited | Conservative application preset; active limits are in AI Studio |
| GitHub Copilot | 10 | Unlimited | Conservative application preset; GitHub publishes no fixed RPM |
| Cohere | 20 | Unlimited | Published trial Chat API limit |
| DeepSeek | Unlimited | 500 | Published account concurrency limit for DeepSeek V4 Pro |
| Unknown | Unlimited | Unlimited | No assumed vendor quota |

Sources: [Anthropic](https://platform.claude.com/docs/en/api/rate-limits),
[OpenAI](https://developers.openai.com/api/docs/guides/rate-limits),
[Gemini](https://ai.google.dev/gemini-api/docs/rate-limits),
[GitHub Copilot](https://docs.github.com/en/copilot/concepts/rate-limits),
[Cohere](https://docs.cohere.com/docs/rate-limits), and
[DeepSeek](https://api-docs.deepseek.com/quick_start/rate_limit).

Set `JARELA_PROVIDER_RATE_LIMITS` in the Environment panel to a JSON object:

```json
{"github-copilot":{"requestsPerMinute":10,"maxConcurrent":2},"custom-provider":{"requestsPerMinute":30}}
```

Omitted fields retain the preset. A JSON `null` means unlimited. Finite values
must be positive integers up to 60,000. Invalid overrides are rejected when the
provider factory initializes its limiter. This setting is not agent-writable;
apply changes with a user-controlled restart when no active runs need preserving.
Queue state is in memory and resets on restart; there is no additional daemon
or persisted rate-limit state.

These are local admission limits, not guarantees against all HTTP 429 errors.
They do not meter tokens, daily/monthly quotas, billing caps, SDK-internal
retries, or traffic from other Jarela processes/apps. Set overrides to match
your actual account limits; existing provider error and retry handling still
applies.

## Durable agent system signals

See [ADR-0091](adr/0091-durable-agent-system-signals.md). Producers publish
targeted lifecycle facts through the operation/event/delivery stores, never by
parsing logs. Same-database outcome changes and outbox publication are atomic.
External effects can still have unknown outcomes after a timeout or crash.

The existing `async_run` tool wrapper records intent before starting work and
emits completion, failure, or timeout signals with the async tracking key.
After restart, unfinished calls are marked interrupted; they are not replayed.
Completed result envelopes are encrypted in SQLite and retained for seven
days. The process-local map remains a fast cache; `tool_result_get` and
`tool_result_list` fall back to durable storage and enforce thread ownership.
References include an expiry; legacy process-local references are not offered
after restart. Owned success and error text use encrypted virtual references,
not plaintext spills. UTF-8-safe pages fit the inline transport budget including
JSON encoding; final-page consume removes durable storage and cached access.
The durable envelope budget is 2 MiB. Larger output produces an explicit
failure receipt. Legacy unowned references retain their existing behavior.

Context delivery defaults: at most 20 events and 8,000 journal characters per
batch, 30-minute renewable leases, five attempts, exponential retry backoff
with jitter capped at roughly one minute, and seven-day acknowledged-record
retention. Admission counts accepted operations plus ready/leased deliveries,
with a 1,000-record per-thread limit. Dead letters are retained for diagnosis;
they are not silently discarded or automatically replayed. No new daemon,
cloud service, additional daemon loop, or arbitrary tool execution API is added.

Restart receipts and authorized background-tool outcomes schedule a bounded
continuation through the existing scheduler and thread queues. At most two
threads wake concurrently; busy threads wait, failed preparation backs off,
and completion turns have a read-only tool permission overlay enforced for
bound and proxied tools. Restart additionally rejects completion-originated
calls and correlates foreground attempts with the persisted direct user
message ID, preventing retries from scheduling another exit. Config,
approval, watcher, and task events remain passive context. The continuation
retrieves output and reports only; further writes require a new user turn.
Completion reads are synchronous even if a model supplies `async_run=true`.
Queue, run-registry/waiter, result-cache, and config state are process-wide so
separate Next route bundles agree on ownership, active runs, and invalidation.
Reassigned signal targets are quarantined instead of waking another agent;
cached output respects durable deletion and expiry.

Owned result/outbox settlement is atomic. Transient settlement failure keeps
the observed outcome for up to five attempts on the existing result sweeper;
it does not rerun the tool. If storage remains unavailable or the process dies
before persistence, external effects may be unknown and require verification.
Native Claude/Codex jobs join on actual terminal callbacks, not launch
acknowledgment. Their owned status tools expose bounded metadata and result
keys rather than duplicating private output into generic spills.

Inspect delivery counts through `read_agent_config` and the Logs panel for
dead-letter notices. The store exposes `systemSignalDiagnostics` for local
inspection. The initial version does not expose a UI dead-letter replay button.

## Dependency upgrade workflow

- Upgrade in batches with one clear failure domain: framework/tooling,
  workspace packages, LangChain/provider SDKs, then high-risk native/runtime
  packages.
- Keep TypeScript and ESLint major jumps on their own branches. They affect
  diagnostics and generated declarations broadly enough that they should not be
  mixed with provider or UI changes.
- After workspace dependency changes, run `npm run packages:build` and
  `npm run packages:test`; package manifests can pass root tests while their
  generated declarations drift.
- After Next.js changes, read the matching guide under `node_modules/next/dist/docs/`,
  then run `npm run build`, `npm run security:routes`, and `npm run test:package`.
- After provider or LangChain changes, run the model-router, provider, MCP/tool,
  and attachment tests before live smoke tests.
