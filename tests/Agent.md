---
description: "Use when: adding or fixing shared test setup, Playwright e2e, or live-test orchestration in tests/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Test suite guidance

Follow [AGENTS.md](../AGENTS.md) and the
[development guide](../docs/DEVELOPMENT.md). Unit tests are co-located with the
source they cover; this directory owns shared setup, Playwright e2e, and test
orchestration.

## What belongs where

| Layer | Location | Tool |
| --- | --- | --- |
| Unit / component | `*.test.ts` / `*.test.tsx` beside the source | Vitest |
| Script self-tests | `scripts/*.test.mjs` | Vitest |
| Browser e2e | `tests/e2e/*.spec.ts` | Playwright |
| E2E server resolver self-test | [e2e-config.node.mjs](./e2e-config.node.mjs) | `node:test` |
| Live server smoke | `scripts/live-test.mjs` via `npm run test:live` | node script |
| LLM evaluation | `npm run test:live:full`, prompt evals | opt-in live |

Vitest only includes `lib/`, `api/`, `app/`, `hooks/`, `components/`,
`scripts/`, and `browser-extension/lib/` test globs
([vitest.config.mts](../vitest.config.mts)). Do not add Vitest unit tests under
`tests/` — they will not run.

## Test selection and assertion contract

Choose the narrowest layer that can fail for the change:

| Change | Layer |
| --- | --- |
| Pure function, parser, policy, schema | Co-located Vitest unit test |
| Hook, controller, async state | Co-located hook test (`jsdom` only when DOM APIs are used) |
| Component behavior, accessibility, focus | RTL component test |
| Route body/status/header contract | Route test against the handler + a client-parity assertion |
| Browser flow across panels or servers | Playwright e2e spec |
| Server bootstrap, provider boundary, install | `npm run test:live` (full only with explicit credentials) |
| Repository gate or automation | `scripts/*.test.mjs` fixture test |

Assertion rules:

- Assert the complete success payload/status or the exact failure
  status/code/message. Read back side effects instead of trusting a success
  boolean.
- One behavior per test, named for the behavior. Cover the failure path in the
  same change as the happy path.
- Prefer user-visible selectors (role, label, text) over structure. Snapshots
  and computed-style assertions belong only in deliberate contract tests.
- Never weaken or delete an assertion to get green. A skip needs a reason
  string.
- Mock only at boundaries: network at the client/module seam, time and timers
  explicitly, filesystem in temp directories, randomness/IDs injected. No live
  network in unit tests and no global mutable state across tests.
- CI retries (`playwright.config.ts` sets 2 on CI) are diagnostics, not
  permission: a retry-hidden flake must be fixed or quarantined with a tracked
  reason.

## Standard patterns

### 1. Isolate persistent state per test file and per worker

- Unit tests receive a fresh `JARELA_DB_DIR` from
  [setup-data-dir.ts](./setup-data-dir.ts). If a file needs a custom directory,
  set `process.env.JARELA_DB_DIR` before dynamically importing the store.
- Playwright gives each worker its own server, port, and SQLite database through
  [fixtures.ts](./e2e/fixtures.ts) and `scripts/e2e-servers.mjs`; the isolation
  probe in [global-setup.ts](./e2e/global-setup.ts) fails the run if servers
  share state.
- Never point tests at the user's real data directory, a running dev server, or
  an existing database ([playwright.config.ts](../playwright.config.ts) sets
  `reuseExistingServer: false`).

### 2. Keep e2e flows serial within a spec

Shared worker state is intentional; order dependence is not. Use
`test.describe.configure({ mode: "serial" })` for multi-step flows and reset
created state in `beforeEach`/`afterEach`. Representative specs:
`tests/e2e/credentials.spec.ts`, `tests/e2e/setup-reorg.spec.ts`,
`tests/e2e/checked-execution-workflow.spec.ts`.

### 3. Seed through the public API

Prefer `workerRequest` and [helpers.ts](./e2e/helpers.ts) (`seedMockAgent`,
`waitForAppReady`) over clicking through unrelated screens. UI interaction is
reserved for the capability under test. API-only specs use the worker request
fixture instead of hand-rolled `request.newContext`.

### 4. Select by accessibility contract

Use `getByRole` and `getByLabel` first. `getByTestId` is for containers and
overlays that have no stable accessible name (`tests/e2e/layout.spec.ts`,
`tests/e2e/smoke.spec.ts`). Avoid CSS-structure selectors.

### 5. Wait on state, not time

Use `expect.poll` or a web-first assertion. `waitForTimeout` is acceptable only
for documented pointer/animation cadence in a focused spec; it must not be the
default wait strategy.

### 6. Opt into the right environment

- RTL tests start with `// @vitest-environment jsdom` and use
  [setup-rtl.ts](./setup-rtl.ts) cleanup.
- E2E specs import `test` and `expect` from [fixtures.ts](./e2e/fixtures.ts),
  not directly from `@playwright/test`.
- Live/LLM tests gate on explicit flags or API keys and skip with a reason.

## Anti-patterns

- **Sharing one database across workers** — the isolation probe exists to catch
  this; do not disable or weaken it.
- **Depending on a previous test's residue** — serial mode does not authorize
  implicit state; reset explicitly.
- **Sleeping instead of polling** — flaky and hides slow regressions.
- **Asserting implementation details in ordinary UI specs** — exact request
  sequences and computed styles belong in deliberate contract tests.
- **Network access in unit tests** — stub `fetch` or the module; live
  network/SDK boundaries belong to `npm run test:live`.
- **Weakening or deleting assertions to get green** — coverage exclusions are
  documented debt in [vitest.config.mts](../vitest.config.mts); adding another
  needs justification.
- **Skipping without a reason** — every `skip` needs a string explaining the
  environment or capability gap.

## Files

- [setup-data-dir.ts](./setup-data-dir.ts) — per-file temp database directory.
- [setup-rtl.ts](./setup-rtl.ts) — global RTL cleanup.
- [e2e-config.node.mjs](./e2e-config.node.mjs) — server resolver and isolation
  self-tests.
- [global-setup.ts](./e2e/global-setup.ts) — cross-server isolation probe.
- [fixtures.ts](./e2e/fixtures.ts) — worker `baseURL` and `workerRequest`.
- [helpers.ts](./e2e/helpers.ts) — seeding and app-readiness helpers.
- [e2e/](./e2e/) — Playwright specs covering shell, panels, credentials,
  documents, tasks, skills, and execution policy.
- E2E orchestration lives in `scripts/e2e-servers.mjs` and
  `scripts/e2e-isolation.mjs`; its conventions are owned by
  [scripts/Agent.md](../scripts/Agent.md).

## Testing requirements

Run the narrowest layer that can fail for the change, then the gate:

1. Focused Vitest file(s) for logic and component changes.
2. `npm run test:e2e` for browser contracts (or the single spec).
3. `npm run test:live` when the change touches the server bootstrap or a live
   provider boundary; `npm run test:live:full` only with explicit credentials.
4. `npm run test:coverage` for coverage-sensitive changes (80% line/function/
   branch/statement thresholds).
5. `npx tsc --noEmit`, `npm run lint`, and the production build for
   cross-cutting changes.

## Review checks

- [ ] Test lives in the correct layer and include glob.
- [ ] Data directory, server port, and external state are isolated.
- [ ] Selectors use role/label unless a test id is justified.
- [ ] Failure path is covered, not only the happy path.
- [ ] Side effects are read back; a success flag alone is not evidence.
- [ ] Mocks stop at network/timer/filesystem boundaries; no live calls.
- [ ] A CI retry would not hide a real race or an unhandled promise.
- [ ] No sleeps, shared residue, or weakened assertions were introduced.

## Frontier

- **Route interception with synthetic data** (`tests/e2e/panel-dashboard.spec.ts`)
  — one implementation; keep the real API shape authoritative.
- **Network evidence assertions** (`page.on("request")` counters in
  `tests/e2e/chat-mock.spec.ts`) — one implementation; not yet standard.
- **Worker-scoped request fixture** (`tests/e2e/checked-execution-workflow.spec.ts`)
  — preferred for new API-only specs, but older specs still hand-roll contexts.
- **Integration-named tests under the Vitest include** — one implementation
  (`lib/lifecycle/system-signals.integration.test.ts`); not yet a separate
  runner layer.
