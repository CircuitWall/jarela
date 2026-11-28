---
description: "Use when: adding, fixing, or testing repository automation in scripts/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Scripts module guidance

Follow [AGENTS.md](../AGENTS.md) and the
[development workflow](../docs/DEVELOPMENT.md). Scripts are repo, CI, and
operator automation — not application runtime code.

## Boundary

- The only published runtime entry is [jarela-bin.mjs](./jarela-bin.mjs). The
  rest support development, release, installation, packaging, or live testing.
- Scripts may import `lib/` helpers (`node:` builtins first); application code
  must not import scripts. The release prompt template now lives in
  `lib/prompts/release-docs.ts`; [release-docs.mjs](./release-docs.mjs) keeps
  its CLI copy under `scripts/prompts/`, and a test asserts both render
  identically. Put new shared logic in `lib/`, not in a script.
- Gate scripts are dependency-light: only `node:` imports unless the script
  genuinely needs the tool (Zod, TypeScript, esbuild, undici). Declare any
  third-party import in `package.json`.
- Do not write application state. Automation that needs persistence uses
  `JARELA_DB_DIR` or a dedicated temporary directory; never the user's real
  database.

## Script classes and portability

| Class | Examples | Extra rules |
| --- | --- | --- |
| Gates | `check-*.mjs` | Read-only by default, repo-root resolved, exit 0/1/2, wired to lint/CI where repository-wide, positive + negative fixtures. Explicit artifact export (`check-module-review --briefs`, `check-feature-contract --packets`) is opt-in. |
| Release/package | [nightly-release.mjs](./nightly-release.mjs), [release-docker.mjs](./release-docker.mjs) | CI-owned; never publish from a developer machine; `package.json` is the version source |
| Install/service | [jarela-bin.mjs](./jarela-bin.mjs), [service-install.mjs](./service-install.mjs), [update.mjs](./update.mjs) | Published/runtime entry points; no dev-only imports; guarded targets |
| Build/docs | [postbuild.mjs](./postbuild.mjs), [sync-docs-assets.mjs](./sync-docs-assets.mjs), [generate-project-history.mjs](./generate-project-history.mjs) | Fixed outputs; reproducible from a clean checkout |
| Test orchestration | [live-test.mjs](./live-test.mjs), [e2e-servers.mjs](./e2e-servers.mjs), [e2e-isolation.mjs](./e2e-isolation.mjs) | Isolated data dirs and ports; live/LLM work is opt-in |
| Maintenance | [snapshot-pricing.mjs](./snapshot-pricing.mjs), [benchmark-database-reads.mjs](./benchmark-database-reads.mjs) | Bounded work; no application state |

Portability rules:

- Support Windows and POSIX with the same code path. No `shell: true`, no
  bash-isms, no hardcoded `/` or `\` separators; use `path.join`/`path.resolve`.
  Invoke npm through its `.cmd` shim or `ComSpec`, and prefer `process.execPath`
  for Node child processes.
- Keep the exit contract: `0` success, `1` failed check/runtime error, `2` usage
  or precondition failure. Document any exception in the script's `usage()`.
- Keep stdout clean for machine consumers. Human diagnostics and failures go to
  stderr with a stable tag; file lists use NUL delimiters when names may contain
  spaces or newlines.
- Write UTF-8 and handle CRLF in fixtures and generated text. Do not depend on
  executable bits, symlinks, or case-sensitive paths.
- Online-only or destructive behavior is opt-in, bounded by a timeout, and
  guarded by an explicit target/precondition. No telemetry or required cloud
  call beyond the user's configured provider.

## Standard patterns

### 1. Resolve the repository root from the module URL

```javascript
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
```

Never rely on the caller's working directory for reads or writes. Scripts that
accept a path must resolve it, reject absolute paths and `..` escapes where the
input is repository-relative, and compare against the root before destructive
operations. Canonical: [check-architecture-patterns.mjs](./check-architecture-patterns.mjs),
[check-agent-docs.mjs](./check-agent-docs.mjs), [backup.mjs](./backup.mjs).

### 2. Parse arguments strictly and document them

Support `--help`/`-h` with a `usage()` block and exit 0. Reject unknown
arguments with exit code 2 and a usage message. Do not silently ignore flags.
Canonical: [check-change-impact.mjs](./check-change-impact.mjs),
[check-git-conventions.mjs](./check-git-conventions.mjs),
[check-function-complexity.mjs](./check-function-complexity.mjs).

### 3. Accumulate failures, exit once

Tag every diagnostic with a stable prefix (`[agent-docs]`,
`[architecture-patterns]`, `[manifest-lint]`). Collect problems in `fail()` by
setting `process.exitCode = 1`, continue checking what you can, then exit once
at the end. Use exit 2 for usage or precondition failures and 1 for a failed
check or runtime error. Canonical:
[check-integration-manifests.mjs](./check-integration-manifests.mjs),
[check-architecture-patterns.mjs](./check-architecture-patterns.mjs).

### 4. Keep stdout clean for machine consumers

Some scripts are protocols: [select-precommit-tests.mjs](./select-precommit-tests.mjs)
emits NUL-delimited tokens to the pre-commit hook, release-docs emits a prompt,
and [check-change-impact.mjs](./check-change-impact.mjs) has a `--json` mode.
Human logs go to stderr or a documented prefix; failures always go to stderr.

### 5. Run Git without a shell

Use `execFileSync` with an argument array. Do not enable `shell: true`; on
Windows prefer selecting `ComSpec`/the `.cmd` executable explicitly, as
[check-npm-package.mjs](./check-npm-package.mjs) and
[run-workspace-script-if-present.mjs](./run-workspace-script-if-present.mjs) do.
Shell wrapping breaks signal and kill propagation and invites injection.
Canonical: [check-git-conventions.mjs](./check-git-conventions.mjs),
[generate-project-history.mjs](./generate-project-history.mjs).

### 6. Guard destructive operations

Recursively deleting or overwriting a path requires a root check, a fixed
target, or an explicit non-empty/dedicated-directory precondition. Good
examples: [backup.mjs](./backup.mjs) (refuses unsafe targets),
[live-test-isolated.mjs](./live-test-isolated.mjs) (dedicated test data
directory), [postbuild.mjs](./postbuild.mjs) (fixed standalone path).
[build-extension.mjs](./build-extension.mjs) accepts an arbitrary `--out` and
deletes it; do not copy that shape.

### 7. Make gates reproducible

Gate scripts read the repository only, use `package.json` as the version source,
and are wired into `npm run lint`, pre-commit, or CI. When adding a gate, add it
to `package.json`, update [this guide's inventory](#inventory), and verify the
exit path directly with representative arguments.

## Anti-patterns

- **`shell: true`** — see pattern 5.
- **CWD assumptions** — scripts that read or mutate `process.cwd()` break
  outside the repo root; resolve from the module URL.
- **`process.exit()` inside helpers** — it skips accumulated diagnostics and
  makes the function untestable. Return a result or set `exitCode`, then exit
  once in `main()`.
- **Untagged output** — every line should identify its script.
- **Stray stdout** — corrupts NUL, JSON, `GITHUB_OUTPUT`, or redirected prompt
  consumers.
- **Undeclared dependencies** — relying on hoisting (for example `sharp` or
  `semver`) breaks isolated installs and the published package.
- **Shipping dev-only gates without intent** — `package.json` `files` is an
  allowlist; check whether a script and its assets are meant for the installed
  app before publishing.

## Inventory

| Group | Scripts |
| --- | --- |
| Gates | [check-architecture-patterns.mjs](./check-architecture-patterns.mjs), [check-agent-docs.mjs](./check-agent-docs.mjs) (guides + architecture-document links), [check-api-docs.mjs](./check-api-docs.mjs) (public routes ↔ docs/api.md), [check-adr-registry.mjs](./check-adr-registry.mjs) (unique ADR ids, citations, links), [check-ui-data-access.mjs](./check-ui-data-access.mjs) (direct fetch/storage ratchet), [check-integration-manifests.mjs](./check-integration-manifests.mjs), [check-dockerfile-workspaces.mjs](./check-dockerfile-workspaces.mjs), [check-ci-workflows.mjs](./check-ci-workflows.mjs), [check-function-complexity.mjs](./check-function-complexity.mjs), [check-change-impact.mjs](./check-change-impact.mjs), [check-module-review.mjs](./check-module-review.mjs) (change-scoped module review + optional `--briefs` export), [check-feature-contract.mjs](./check-feature-contract.mjs) (on-demand feature contract + packets), [check-git-conventions.mjs](./check-git-conventions.mjs) |
| Security/package | [scan-secrets.mjs](./scan-secrets.mjs), [scan-sensitive-terms.mjs](./scan-sensitive-terms.mjs), [check-route-bundles.mjs](./check-route-bundles.mjs), [check-npm-package.mjs](./check-npm-package.mjs), [check-link-preview-version.mjs](./check-link-preview-version.mjs) |
| Hooks/tests | [select-precommit-tests.mjs](./select-precommit-tests.mjs), [setup-git-hooks.mjs](./setup-git-hooks.mjs), [live-test.mjs](./live-test.mjs), [live-test-isolated.mjs](./live-test-isolated.mjs), [isolated-dev.mjs](./isolated-dev.mjs), [e2e-servers.mjs](./e2e-servers.mjs), [e2e-isolation.mjs](./e2e-isolation.mjs) |
| Release/package | [nightly-release.mjs](./nightly-release.mjs), [approve-release-ci.mjs](./approve-release-ci.mjs), [ci-release-metadata.mjs](./ci-release-metadata.mjs), [release-changeset.mjs](./release-changeset.mjs), [release-docs.mjs](./release-docs.mjs), [release-docker.mjs](./release-docker.mjs), [rewrite-workspace-deps.mjs](./rewrite-workspace-deps.mjs), [prune-npm-source-maps.mjs](./prune-npm-source-maps.mjs), [standalone-footprint.mjs](./standalone-footprint.mjs) |
| Install/service | [jarela-bin.mjs](./jarela-bin.mjs), [service-install.mjs](./service-install.mjs), [start-prod.mjs](./start-prod.mjs), [update.mjs](./update.mjs), [backup.mjs](./backup.mjs), [runtime-version.mjs](./runtime-version.mjs), [postinstall-hint.mjs](./postinstall-hint.mjs) |
| Build/docs | [postbuild.mjs](./postbuild.mjs), [build-extension.mjs](./build-extension.mjs), [build-branded-app.mjs](./build-branded-app.mjs), [build-workspace-package.mjs](./build-workspace-package.mjs), [prepare-local-embedding-model.mjs](./prepare-local-embedding-model.mjs), [sync-docs-assets.mjs](./sync-docs-assets.mjs), [generate-project-history.mjs](./generate-project-history.mjs), [dump-prompts.mjs](./dump-prompts.mjs) |
| Maintenance | [eslint-api-responses.mjs](./eslint-api-responses.mjs), [benchmark-database-reads.mjs](./benchmark-database-reads.mjs), [snapshot-pricing.mjs](./snapshot-pricing.mjs), [gen-logo.mjs](./gen-logo.mjs), [gmail-oauth.mjs](./gmail-oauth.mjs), [cadence-audit.mjs](./cadence-audit.mjs) (clock-driven audit; report-only, no model calls) |

## Testing requirements

- Tests are co-located `scripts/*.test.mjs` and run under Vitest
  (`scripts/**/*.test.mjs` is in the include globs). Import exported functions,
  not the CLI entry point.
- Use temporary directories for filesystem fixtures and clean them up; use
  isolated Git repositories for history/release tests.
- Assert exit codes and machine output separately from human diagnostics.
  Mock `node:child_process` or the destructive filesystem call rather than
  performing it.
- Every new gate needs at least one positive and one negative fixture. Tests do
  not exist for several older gates; add coverage when changing them.
- Run the focused test, `npx eslint scripts`, `npx tsc --noEmit`, and
  `npm run lint`.

## Gate wiring

- `npm run lint` runs ESLint, the complexity ratchet, architecture patterns,
  agent docs, integration manifests, Dockerfile workspaces, and CI workflows
  (`package.json`).
- `.githooks/pre-commit` runs `check-git-conventions.mjs --branch`,
  `check-module-review.mjs` on the staged change, and
  `select-precommit-tests.mjs`; `.githooks/commit-msg` enforces the commit
  subject.
- PR CI runs `check-module-review.mjs` against the pull-request range, plus
  lint, unit/coverage, live tests, and e2e; release workflows call the release
  scripts. Update the workflow when a gate becomes required.
- `check-feature-contract.mjs` is on-demand for Tier 2 feature work. It requires
  a contract file, so it is not wired into lint, pre-commit, or CI; the final
  tree still runs the repository-wide gates.

## Review checks

- [ ] Repo root resolved from the module URL; no CWD assumptions.
- [ ] Unknown args rejected; `--help` documents usage and exit codes.
- [ ] Diagnostics tagged and sent to the right stream; machine stdout clean.
- [ ] No `shell: true`; no undeclared dependency.
- [ ] Runs on Windows and POSIX without shell-specific syntax.
- [ ] Destructive and online-only paths are opt-in, bounded, and guarded.
- [ ] Exit codes and machine stdout are documented and tested.
- [ ] Gate added to `package.json`/guide inventory and covered by a fixture test.

## Frontier

- **Advisory versus gating** ([check-change-impact.mjs](./check-change-impact.mjs)):
  `--fail-on-warnings` is a one-script convention, not yet standard.
- **Consolidated repository-root helper** — the same ten-line resolver appears
  in many scripts with different names. A scripts-internal helper would remove
  duplication if the no-import rule is relaxed.
- **Machine-readable output mode** — `--json` exists in
  [check-change-impact.mjs](./check-change-impact.mjs),
  [check-module-review.mjs](./check-module-review.mjs), and
  [check-feature-contract.mjs](./check-feature-contract.mjs); consider
  standardizing the envelope before CI consumes it.
