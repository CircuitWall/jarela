# Development workflow

This guide focuses on developer experience for UI/state work.

## Quick commands

- Install: `npm install`
- Lint all: `npm run lint`
- Lint hooks only: `npm run lint:hooks`
- Test all: `npm test`
- Test hooks only: `npm run test:hooks`
- Watch hook tests: `npm run test:hooks:watch`

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
