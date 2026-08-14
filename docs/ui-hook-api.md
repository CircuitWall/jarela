# UI Hook API specification

This document defines the stable contract for client-side React hooks used by
Jarela UI modules and internal extensions.

Scope:

- Applies to hooks under [hooks/](../hooks/)
- Covers return-shape conventions, compatibility guarantees, and known limits
- Complements HTTP API docs in [docs/api.md](./api.md)

## Contract model

Stateful hooks SHOULD follow the unified contract shape:

```ts
type UnifiedHookResult<TState extends object, TCommands extends object> = {
  state: TState;
  commands: TCommands;
} & TState & TCommands;
```

Meaning:

- Canonical surface is state + commands
- Flat fields are returned in parallel for backward compatibility
- New consumers should use state + commands

## Current unified hooks

- [hooks/useAgents.ts](../hooks/useAgents.ts)
- [hooks/useBridges.ts](../hooks/useBridges.ts)
- [hooks/useMemory.ts](../hooks/useMemory.ts)
- [hooks/useModels.ts](../hooks/useModels.ts)
- [hooks/useTools.ts](../hooks/useTools.ts)
- [hooks/usePackages.ts](../hooks/usePackages.ts)
- [hooks/useAgentSession.ts](../hooks/useAgentSession.ts)
- [hooks/useMessageFilters.ts](../hooks/useMessageFilters.ts)
- [hooks/useSettingsAttention.ts](../hooks/useSettingsAttention.ts)

## Behavioral guarantees

- Async hooks expose an explicit loading flag and a nullable error string.
- Event-driven invalidation uses window events (for example
  jarela:tools-changed, jarela:models-changed).
- command methods are side-effecting operations; they may update local state
  optimistically before server confirmation.
- Hook commands are safe to call repeatedly; stale async responses are guarded
  where race risk is known (for example thread selection in useAgentSession).

## Compatibility and migration policy

- state + commands is the long-term API.
- Flat fields remain available during migration windows.
- Removals of flat fields follow the public-surface process in
  [CONTRIBUTING.md](../CONTRIBUTING.md) and require a deprecation cycle.

## Limitations

- Client-only: these hooks require browser runtime and are not server-component
  APIs.
- Transport assumptions: many hooks depend on local event dispatch and
  same-origin HTTP routes.
- Eventual consistency: optimistic writes can temporarily diverge from server
  truth until refresh/reload.
- No hard real-time guarantees: event delivery and SSE reconnect timing depend
  on browser scheduling and tab visibility.
- Not a network API: external non-React integrations should use
  [docs/api.md](./api.md) instead of importing hook modules.

## Test expectations

Any hook added to the unified contract should include a contract test that
asserts:

- state and commands exist and are callable
- compatibility flat fields mirror canonical fields
- one representative async/event path for refresh or invalidation

Reference tests:

- [hooks/unifiedHookContracts.test.ts](../hooks/unifiedHookContracts.test.ts)
- [hooks/useListState.test.ts](../hooks/useListState.test.ts)
- [hooks/useAgentSession.test.ts](../hooks/useAgentSession.test.ts)
- [hooks/useMessageFilters.test.ts](../hooks/useMessageFilters.test.ts)
- [hooks/useSettingsAttention.test.ts](../hooks/useSettingsAttention.test.ts)