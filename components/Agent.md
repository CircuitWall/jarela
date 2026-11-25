---
description: "Use when: implementing, fixing, or testing React components in components/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Components module guidance

Follow [AGENTS.md](../AGENTS.md) and the
[UI hook specification](../docs/ui-hook-api.md). Components are domain UI: they
consume API contracts and browser state, and never own persistence.

## Boundary

Components may import `@/api/client` and `@/api/types`, hooks, contexts,
`@/lib/ui` browser helpers, pure `@/lib/utils` functions, and read-only domain
helpers (for example recall policy, env schema, dashboard sorting). Representative
composition: [AgentsPanel.tsx](./agents/AgentsPanel.tsx),
[ChatView.tsx](./chat/ChatView.tsx), [AppShell.tsx](./layout/AppShell.tsx).

Do not import `lib/db`, `lib/stores`, `lib/crypto`, `lib/scheduler`,
`lib/notifications`, or app route modules. ESLint enforces those server-only
restrictions for `components/` and `hooks/`. Persistence and
provider/authorization work stay server-owned; the credential editor keeps form
state in `hooks/useIntegrationCredential.ts` and authorization sessions in
`hooks/useIntegrationOAuth.ts`, while
[IntegrationCard.tsx](./credentials/IntegrationCard.tsx) only composes views.

## Standard patterns

### 1. Panel shell and header

Every panel composes [PanelHeader.tsx](./ui/PanelHeader.tsx) with
`PanelHeader`/`HeaderAction`, the shared workspace tokens, and `data-deep-link-id`
for deep links. Do not hand-roll page gutters or docked widths; the
workspace-layout pattern is recorded in
[architecture-patterns.json](../docs/architecture-patterns.json).

Canonical: [AgentsPanel.tsx](./agents/AgentsPanel.tsx),
[DocumentsPanel.tsx](./documents/DocumentsPanel.tsx). Test:
[shared-config-ui.test.tsx](./ui/shared-config-ui.test.tsx) and the layout e2e
spec.

### 2. Controller hook beside the view

Private controllers own loading, mutations, feedback, and resource lifetimes;
views destructure the controller and render sections. This is the ownership rule
from [ARCHITECTURE.md](../docs/ARCHITECTURE.md).

Canonical: [useDocumentsPanel.ts](./documents/useDocumentsPanel.ts) +
[DocumentsPanel.tsx](./documents/DocumentsPanel.tsx);
[useRuntimeEnvSettings.ts](./env/useRuntimeEnvSettings.ts) +
[EnvVarsPanel.tsx](./env/EnvVarsPanel.tsx);
[useModelEditorForm.ts](./models/model-editor/useModelEditorForm.ts) +
[ModelEditor.tsx](./models/ModelEditor.tsx).

### 3. API client with visible failure feedback

Call the typed client, not `fetch`. Surface errors through `errorMessage` and
the shared toast/notice primitives; keep a retry path. Canonical error shape:
[client.ts](../api/client.ts) throws `Error` carrying status and `body.error`.

Representative: [useDocumentsPanel.ts](./documents/useDocumentsPanel.ts),
[MCPPanel.tsx](./mcp/MCPPanel.tsx), [useDashboardData.ts](./dashboard/useDashboardData.ts).

### 4. Explicit loading, empty, error, and success states

Render all four. Use [useListState.ts](../hooks/useListState.ts) for list CRUD
and [PanelMessage.tsx](./ui/PanelMessage.tsx) or [Notice.tsx](./ui/Notice.tsx)
for feedback. Do not render an empty collection when the request failed.

Canonical: [AgentsPanel.tsx](./agents/AgentsPanel.tsx),
[MCPPanel.tsx](./mcp/MCPPanel.tsx),
[WatchersSection.tsx](./scheduled-tasks/WatchersSection.tsx).

### 5. Shared dialog contract

Use [Dialog.tsx](./ui/Dialog.tsx) and [DialogFooter.tsx](./ui/DialogFooter.tsx):
portal, topmost-Escape stack, scroll lock, backdrop press/release, pinned
header/footer, `role="dialog"` and `aria-modal`. Editors guard close through
`hooks/useDismissGuard.ts`; footer status uses `role="status"`/`role="alert"` by
severity.

Test: [dialog-contract.test.tsx](./ui/dialog-contract.test.tsx).

### 6. Shared primitives before new markup

Check [components/ui/](./ui/) first: `Button`, `TextField`, `Select`,
`SettingsCard`, `SubTabBar`, `StickyActionBar`, `MetaRow`, `Badge`,
`StatusDot`, `CollapseChevron`, `MarkdownTextarea`. Conditional classes are
template literals over semantic tokens (`bg-surface-2`, `text-fg`,
`border-border`, `accent`, `workspace-gutter`) defined in
[app/globals.css](../app/globals.css). There is no `clsx`/`cn` helper.

### 7. Client boundary and accessibility

Client components start with `"use client"` on line 1; presentational leaves may
omit it. Use `lucide-react` icons at 12–16px, marked `aria-hidden` or inside a
labelled button. Prefer `getByRole`/`getByLabel` contract points over test ids.
`memo` is reserved for hot chat rows; do not memoize by default.

## Anti-patterns

- **Direct `fetch`** — 21 components still call endpoints that are absent from
  the typed client (voice/TTS, redaction, health, update, authoring). This is
  known debt, not a pattern; add the endpoint to `api/client.ts` when touching
  one of these flows.
- **Direct `localStorage`** — only currency, crypto-fallback, and update banners
  do this; new persistent UI preference belongs in a hook or the settings store.
- **Duplicating shared logic** — the avatar-gradient hash exists twice
  (`components/agents/AgentsPanel.tsx`, `components/ui/Toaster.tsx`); extract a
  shared helper instead of adding a third copy.
- **Oversized components** — chat transcripts
  ([MessageList.tsx](./chat/MessageList.tsx),
  [MessageBubble.tsx](./chat/MessageBubble.tsx),
  [ToolList.tsx](./chat/ToolList.tsx)) and several editors exceed the
  function-body ratchet's intent. Split along controller/view or section
  boundaries, not arbitrary line counts.
- **One-off overlays or dialog markup** — use the shared Dialog; only
  `components/ui/Dialog.tsx` and `components/ui/ServerStatus.tsx` may portal.
- **Rendering custom colors instead of tokens** — check the semantic token set
  before adding hex values or arbitrary Tailwind palette classes.

## File map

| Area | Contents |
| --- | --- |
| [layout/](./layout/) | App shell, menu, agent switcher |
| [ui/](./ui/) | Shared primitives (34 files, 20 tests) |
| [chat/](./chat/) | Chat transcript, composer, controllers, helpers |
| [agents/](./agents/), [models/](./models/), [tools/](./tools/) | Configuration panels and editors |
| [dashboard/](./dashboard/), [documents/](./documents/), [memory/](./memory/) | Domain panels and data controllers |
| [credentials/](./credentials/), [integrations/](./integrations/), [mcp/](./mcp/) | Credential and integration surfaces |
| [skills/](./skills/), [proposals/](./proposals/), [scheduled-tasks/](./scheduled-tasks/), [triggers/](./triggers/) | Workflow and automation surfaces |
| [setup/](./setup/), [profile/](./profile/), [settings/](./settings/), [env/](./env/) | Onboarding and settings |
| [harness/](./harness/), [bridges/](./bridges/), [logs/](./logs/) | Runtime and integration surfaces |

Naming: PascalCase `.tsx` for components, lowercase modules for helpers,
kebab-case subdirectories (`components/agents/agent-editor/`,
`components/models/model-editor/`, `components/setup/wizard/`). Named
exports only; no default exports. Props are inline objects or `Props`/`XProps`
interfaces; callbacks use `onX`, with past-tense `onChanged`/`onSaved` for
post-success notification.

## Testing requirements

- Co-located tests: `components/**/*.test.tsx` or a `.test.ts` sibling. Add
  `// @vitest-environment jsdom` on line 1 unless the file is pure logic.
- Query by role/label; assert user-visible behavior, not class names or internal
  state. Use `findBy*`/`waitFor` for async transitions.
- Mock `@/api/client` with `vi.hoisted` + `vi.mock`, or stub `fetch` with
  `vi.stubGlobal`; never hit the network.
- Cover loading, empty, error, and success states, plus dialog dismissal and
  keyboard behavior when the component owns an overlay.
- Run the focused component test, `npx tsc --noEmit`, and `npm run lint`.
  `npm run lint:complexity` rejects new oversized function bodies.

## Pre-PR checklist

- [ ] No persistence/server imports and no new direct `fetch`.
- [ ] Controller owns async work; view stays presentational.
- [ ] All four states render, including failed requests.
- [ ] Shared Dialog/panel/header primitives reused.
- [ ] Accessibility roles and labels are present for new controls.

## Frontier

- **Lazy setup-guide chunks** ([IntegrationSetupGuides.tsx](./credentials/IntegrationSetupGuides.tsx)):
  one implementation of dynamic loading with a status fallback.
- **`state`/`commands` constructor adapters**
  ([IntegrationCard.tsx](./credentials/IntegrationCard.tsx)): one
  implementation of the hook-spec adapter; promote when a second component
  needs it.
- **Cross-panel `CustomEvent` bus**
  ([AddCredentialDialog.tsx](./credentials/AddCredentialDialog.tsx),
  [EnvSync.tsx](./integrations/EnvSync.tsx)): most dispatch lives in hooks; a
  second component-level dispatcher should reuse the hook helper instead of
  inventing a new event name.
- **`inert` collapsed content** ([SettingsCard.tsx](./ui/SettingsCard.tsx)):
  one implementation; check browser support before standardizing.
