# Development workflow

This guide focuses on developer experience for UI/state work.

## Quick commands

- Install: `npm install`
- Lint all: `npm run lint`
- Lint hooks only: `npm run lint:hooks`
- Test all: `npm test`
- Test hooks only: `npm run test:hooks`
- Watch hook tests: `npm run test:hooks:watch`

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
