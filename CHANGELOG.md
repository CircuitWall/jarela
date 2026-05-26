# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Trigger abstraction + change-tracker primitive** (ADR-0025). The
  scheduler no longer owns the firing logic for scheduled tasks
  directly. A new `lib/triggers` module defines a `TriggerHandler`
  interface (`getDueFirings` + `markFired`) and a shared
  `runTriggerAgent()` runner; the existing cron / once scheduled
  tasks are now one such handler, sharing the silent-mode wrapping
  and `scheduled_task` category tagging unchanged. A new
  `change_tracker` SQLite table + `lib/stores/change-tracker.ts`
  expose `recordSeen(scope, key, fingerprint)` for any subsystem
  that needs "has this file / record / etag moved since I last
  looked?" semantics. Both primitives are internal scaffolding for
  upcoming tool-call and `fs.watch` triggers; no user-visible
  surface in this release.
- **Documents**: index any folder on disk for semantic recall. The
  new Documents tab lets the user point Jarela at one or more
  folders; text files (markdown, code, configs, plain text) are
  chunked, embedded with the configured model, and surfaced to
  agents via the `documents_search` tool. Reindex runs automatically
  every ~10 minutes from the scheduler; the panel offers per-source
  `Reindex now`, enable/disable, and a preview-search input.
  Embedding failures gracefully degrade to substring matching so
  installations without an embedding provider still get useful
  results. See ADR-0024 (`docs/adr/0024-document-rag.md`).

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
