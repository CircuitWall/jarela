# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
