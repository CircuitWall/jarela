# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
