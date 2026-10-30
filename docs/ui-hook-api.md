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
- [hooks/useSSE.ts](../hooks/useSSE.ts)
- [hooks/useUrlSync.ts](../hooks/useUrlSync.ts)
- [hooks/useLocationSharing.ts](../hooks/useLocationSharing.ts)
- [hooks/useEventNotifications.ts](../hooks/useEventNotifications.ts)
- [hooks/useIntegrationOAuth.ts](../hooks/useIntegrationOAuth.ts) (unreleased)
- [hooks/useIntegrationCredential.ts](../hooks/useIntegrationCredential.ts) (unreleased)

### Credential editor ownership (unreleased)

[IntegrationCard](../components/credentials/IntegrationCard.tsx) adapts its existing
`credential`/`createNew` props once into a typed `default | create | edit` mode;
a bound credential takes precedence. It composes views and connects their
commands, but does not perform credential API calls.

| Owner | Responsibility |
| --- | --- |
| [useIntegrationCredential](../hooks/useIntegrationCredential.ts) | Form values, label, feedback, save/test/remove/default actions, and mode-specific API dispatch. |
| [IntegrationCredentialForm](../components/credentials/IntegrationCredentialForm.tsx) | Fields, shell provenance, mask clearing on focus, and Claude connection/launch groups. |
| [IntegrationCredentialActions](../components/credentials/IntegrationCredentialActions.tsx) | Mode-specific buttons, disabled states, and existing provider guidance. |
| [IntegrationSetupGuides](../components/credentials/IntegrationSetupGuides.tsx) | Unchanged Gmail, Outlook, and Claude setup walkthroughs. |
| [useIntegrationOAuth](../hooks/useIntegrationOAuth.ts) | Authorization session and popup/polling lifecycle. |

The credential hook returns `state` (values, label, saving, testing, error, and
testResult) and `commands` (form/feedback setters, save, test, remove, and
promoteToDefault), with matching flat fields. Saved-version changes reseed
fields; ordinary rerenders preserve unsaved edits. Changing provider, mode, or
credential identity invalidates pending UI updates and confirmations so an old
operation cannot overwrite another editor. Already-issued API writes are not
cancelled or rolled back.

Default saves still use the integration API and display returned masks before
the optional default-label update. Named saves omit mask sentinels. Failed
default-label lookup/update now reports an error instead of silently claiming
complete success; the credential values may already have been saved. Failed
Clear operations also surface in the card. Tests cover these intentional
failure-path changes in the [hook](../hooks/useIntegrationCredential.test.ts)
and [card](../components/credentials/IntegrationCard.test.tsx).

This is a responsibility split, not a bundle-size optimization; provider guides
are not lazy-loaded.

### Integration OAuth lifecycle (unreleased)

`useIntegrationOAuth` owns Gmail/Outlook authorization start, the popup, and status
polling through the existing typed API client. It accepts the integration name,
optional bound credential ID, configured status, current field values, and
feedback/refresh callbacks; it returns `state.connecting` and
`commands.connectOAuth`, with matching flat fields. Errors and results use the
credential hook's setters rather than duplicate feedback state in the OAuth hook.

The hook preserves bundled Gmail setup, Outlook's app-input guard, input
sanitization, saved-mask omission, targeted credential IDs, existing messages,
1.5-second polling, and expiry on the first poll tick after ten minutes.
Only one status request runs at a time. Unmounting, changing integration,
editor mode, or credential identity, completion, expiry, and failure invalidate the session, so
late responses cannot update the card or a later authorization attempt.
Expiry is checked even while a status request is pending.

Validate the return contract with
[hook tests](../hooks/useIntegrationOAuth.test.ts) and user-visible behavior with
[card tests](../components/credentials/IntegrationCard.test.tsx). These are mocked
local checks, not proof of vendor consent or resource authorization.

Unreleased setup-guide disclosures keep their lightweight summaries in the
credential form and load the shared
[guide-content chunk](../components/credentials/IntegrationSetupGuideContent.tsx)
only after a guide first opens. Loaded content stays mounted across later
close/open actions. The provider text is unchanged; chunk-load errors reach the
existing React error boundary rather than being presented as empty guidance.

## Behavioral guarantees

### Component-local controllers (unreleased)

The complexity cleanup keeps private controllers next to their views rather
than adding them to the shared hook API. For example,
[approvals](../components/proposals/ApprovalsBanner.tsx) separate queue and secret
state; [onboarding](../components/setup/OnboardingWizard.tsx) separates loaded data
from step control; [installation](../components/tools/InstallPanel.tsx) separates
package actions, installation progress, and manifest editing; and
[toasts](../components/ui/Toaster.tsx) separate lifetime from issue reporting.
These are internal ownership boundaries, not new extension contracts.

[useRuntimeEnvSettings](../components/env/useRuntimeEnvSettings.ts) is shared by
the runtime and network environment editors. It accepts a `runtime | network`
scope and restart reason, owns rows/loading/error, editing and saving state,
restart flags, and save/reset/restart actions. Save and reset refresh runtime
configuration and reload rows; failed writes or reloads retain the draft.
Unreleased lifecycle hardening aborts panel-owned requests and health polling
on unmount or scope changes, ignores late completions, and prevents duplicate
restart confirmations. Restart validates the POST status before polling health;
rejection preserves the restart-needed flag and surfaces the server error.
The 30-second polling deadline also aborts a stalled health request. Aborting
an already-issued mutation does not roll back server-side changes.

The existing public notification hook retains its return contract while routing
and delivery are separate internal operations. Timer cleanup, API payloads,
masked-secret omission, and event ordering remain behavior-test obligations;
shorter functions alone do not verify them.

### Shared hook guarantees

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
- [hooks/useSSE.test.ts](../hooks/useSSE.test.ts)
- [hooks/useUrlSync.test.ts](../hooks/useUrlSync.test.ts)
- [hooks/useLocationSharing.test.ts](../hooks/useLocationSharing.test.ts)
- [hooks/useEventNotifications.test.ts](../hooks/useEventNotifications.test.ts)

## Naming and packaging conventions

- Hook implementation files live in [hooks/](../hooks/) and are named
  use{Name}.ts.
- Hook contract tests live in [hooks/](../hooks/) and are named
  use{Name}.test.ts.
- Avoid placing hook tests under [components/](../components/).
- Only use .tsx for tests when JSX is strictly required.