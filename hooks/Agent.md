---
description: "Use when: implementing, fixing, or testing browser hooks in hooks/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Browser hooks module guidance

Follow [AGENTS.md](../AGENTS.md) and the
[UI hook specification](../docs/ui-hook-api.md). Hooks own browser state and API
dispatch; they never own persistence or rendering.

## Boundary

- Hooks may call [the API client](../api/client.ts), React contexts, and pure
  browser-safe helpers. The dependency direction is UI → API routes → runtime →
  stores ([module map](../docs/ARCHITECTURE.md)).
- Do not import `lib/db`, `lib/stores`, SQLite, `server-only`, or app route
  modules. ESLint enforces the server-only import restriction for `hooks/`. Do
  not write `fetch` calls that bypass `@/api/client`; the two known holdouts
  (`hooks/useEnvSettings.ts`, `hooks/useMessageFilters.ts`) are debt, not
  precedent.
- Do not render UI or own component-private state. A controller hook owns
  loading, mutations, feedback, and resource lifetimes for its component; see
  the credential-editor ownership split in [the hook spec](../docs/ui-hook-api.md).
- Keep shared types in `api/types.ts` or co-locate and export them from the
  hook. A type-only import from a component (as in
  [useSSE.ts](./useSSE.ts) for `ToolEvent`) is a documented exception, not a
  pattern to extend.

## Standard patterns

### 1. Supersede stale async results

Every request that can outlive a dependency change gets a request id, sequence
number, or session token, and late results are dropped rather than applied.
Canonical: [useListState.ts](./useListState.ts) (request-id compare),
[useAgentSession.ts](./useAgentSession.ts) (sequence counter), and
[useMessageFilters.ts](./useMessageFilters.ts).

```typescript
const requestId = ++requestIdRef.current;
const items = await api.list();
if (requestId !== requestIdRef.current) return;
```

Tests: [useListState.test.ts](./useListState.test.ts) (out-of-order resolves),
[useMessageFilters.test.ts](./useMessageFilters.test.ts) (late prior-agent GET).

### 2. Own every subscription and timer

Effects that attach listeners, EventSource/SSE subscriptions, intervals, or
AbortControllers must return cleanup and guard callbacks with an active check.
Canonical: [useEventNotifications.ts](./useEventNotifications.ts) (reconnect +
visibility), [useSSE.ts](./useSSE.ts) (run abort), and
[useIntegrationOAuth.ts](./useIntegrationOAuth.ts) (polling interval and
per-attempt `isActive`).

Tests: [useEventNotifications.test.ts](./useEventNotifications.test.ts),
[useSSE.lifecycle.test.ts](./useSSE.lifecycle.test.ts),
[useIntegrationOAuth.test.ts](./useIntegrationOAuth.test.ts) (timer count
returns to zero).

### 3. Keep command identity stable

Stateful hooks expose `{ state, commands }` where command functions come from
`useCallback` and read late-changing options through refs. Stability is part of
the contract: consumers must be able to depend on `start`, `attach`, or
`refresh` without re-subscribing. Canonical:
[useListState.ts](./useListState.ts) (return type) and
[useSSE.ts](./useSSE.ts).

Tests: [unifiedHookContracts.test.ts](./unifiedHookContracts.test.ts) asserts
aliases and command identity; [useSSE.lifecycle.test.ts](./useSSE.lifecycle.test.ts)
asserts identity survives state updates.

### 4. Use the shared list-state primitive

CRUD list hooks should compose [useListState.ts](./useListState.ts) for
`items`, `loading`, `error`, `refresh`, event invalidation, and request
supersede. Representative consumers: [useAgents.ts](./useAgents.ts),
[useMemory.ts](./useMemory.ts), [useModels.ts](./useModels.ts),
[useTools.ts](./useTools.ts), [usePackages.ts](./usePackages.ts).

Tests: [useAgents.test.tsx](./useAgents.test.tsx) (initial loading),
[useListState.test.ts](./useListState.test.ts) (error clears items).

### 5. Model errors as visible state

Use `error: string | null` (or a typed test-result state) and keep failed
requests visible; never collapse a failure into an empty successful result.
Canonical: [useListState.ts](./useListState.ts),
[useIntegrationCredential.ts](./useIntegrationCredential.ts).

### 6. Guard browser globals

Hooks touched during SSR or tests must guard `window`, `localStorage`,
`matchMedia`, and `EventSource` access, and provide a conservative server
snapshot. Canonical: [useReducedMotion.ts](./useReducedMotion.ts) and
[useEventNotifications.ts](./useEventNotifications.ts).

## Anti-patterns

- **Fire-and-forget requests without cancellation** — untracked loads can apply
  after unmount or after the selected agent changed. Fix by adopting the
  request-id/session pattern above.
- **Module-level mutable caches without invalidation** — if a hook needs a
  process cache (for example [useCredentialProbes.ts](./useCredentialProbes.ts)),
  it must expose or subscribe to an invalidation event and document its
  lifetime.
- **Expanding the shared hook API for private UI state** — component-local
  controllers belong with the component; see the hook spec's ownership rules.
- **Hiding request failures** — do not return `[]` or `null` when the request
  failed. Keep the error state and let the component decide how to present it.
- **Adding `eslint-disable react-hooks/exhaustive-deps` without evidence** —
  existing suppressions are deliberate and ref-latched; new ones need a comment
  explaining which identity is intentionally excluded.

## File map

| Area | Files |
| --- | --- |
| List/CRUD | `useAgents.ts`, `useMemory.ts`, `useModels.ts`, `useTools.ts`, `usePackages.ts`, `useBridges.ts`, `useListState.ts` |
| Agent session | `useAgentSession.ts` |
| Streaming/events | `useSSE.ts`, `useEventNotifications.ts` |
| Credentials/integrations | `useIntegrationCredential.ts`, `useIntegrationOAuth.ts`, `useCredentialProbes.ts` |
| Settings/policy | `useEnvSettings.ts`, `useSettingsAttention.ts`, `useConfigurationIssues.ts`, `useMessageFilters.ts` |
| UI behavior | `useDismissGuard.ts`, `useEscapeKey.ts`, `useIconFile.ts`, `useReducedMotion.ts`, `useUrlSync.ts`, `useDeepLinkScroll.ts`, `useLocationSharing.ts` |

Stateful hooks return `{ state, commands }` plus flat compatibility fields;
utility hooks return a bare value or object. All exports are named; no default
exports. Newer hooks spread `...state, ...commands`, while older hooks list flat
fields explicitly — preserve the module's existing contract per hook.

## Testing requirements

- Add a co-located `hooks/use<Name>.test.ts` (`.tsx` only when JSX is required).
  Files that touch DOM APIs start with `// @vitest-environment jsdom`.
- Mock `@/api/client` with `vi.mock` or spy on the real client; do not hit the
  network. Stub `EventSource`, `matchMedia`, `FileReader`, and timers explicitly.
- Cover: initial load, error state, superseded/late results, unmount cleanup,
  and command identity when the hook exposes commands.
- [unifiedHookContracts.test.ts](./unifiedHookContracts.test.ts) is the
  cross-cutting contract suite: a stateful hook must expose callable commands,
  flat aliases that mirror canonical fields, and one refresh/invalidation path.
- Run `npm run test:hooks`, `npm run lint:hooks`, and `npx tsc --noEmit`.

## Pre-PR checklist

- [ ] No store/SQLite/server imports and no new inline `fetch`.
- [ ] Every subscription, timer, listener, and request has a cleanup or
      supersede guard.
- [ ] Commands are stable and errors stay visible.
- [ ] Focused hook tests cover success, failure, and unmount.
- [ ] Contract test updated when the public return shape changes.

## Frontier

- **Session-generation tokens** ([useIntegrationCredential.ts](./useIntegrationCredential.ts),
  [useIntegrationOAuth.ts](./useIntegrationOAuth.ts)): per-attempt active
  objects invalidate late saves and probes. Two implementations; keep the token
  shape aligned before standardizing.
- **Latest-callback refs** ([useEventNotifications.ts](./useEventNotifications.ts),
  [useIconFile.ts](./useIconFile.ts), [useIntegrationOAuth.ts](./useIntegrationOAuth.ts)):
  keeps subscriptions stable without dependency churn. Promote once a third
  independent implementation matches.
- **`useSyncExternalStore`** ([useReducedMotion.ts](./useReducedMotion.ts)):
  single use; not yet the standard for external-store hooks.
- **Private sub-hook composition** ([useSSE.ts](./useSSE.ts)): one file owns
  five private controllers. This is a single-module innovation, not yet a
  cross-module pattern.
