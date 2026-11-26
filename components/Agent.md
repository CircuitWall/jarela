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

### 6. Shared primitives and class conventions

Check [components/ui/](./ui/) first; [section 9](#9-reuse-ladder-and-promotion)
maps common needs to primitives. Conditional classes are template literals over
semantic tokens from [app/globals.css](../app/globals.css); there is no
`clsx`/`cn` helper.

### 7. Client boundary and accessibility

Client components start with `"use client"` on line 1; presentational leaves may
omit it. Use `lucide-react` icons at 12–16px, marked `aria-hidden` or inside a
labelled button. Prefer `getByRole`/`getByLabel` contract points over test ids.
`memo` is reserved for hot chat rows; do not memoize by default.

### 8. Design language: semantic tokens and fixed scales

The visual system is defined once in [app/globals.css](../app/globals.css). Apply
it; never restyle around it.

- **Color:** use semantic utilities only — `surface`, `surface-2`, `surface-3`,
  `border`, `fg`, `fg-muted`, `fg-subtle`, `fg-faint`, `accent`,
  `accent-hover`. They carry the light/dark palettes and contrast targets.
  Never add hex values, arbitrary palette classes, or per-component theme
  overrides. The `danger` variant's rose classes in
  [Button.tsx](./ui/Button.tsx) are the reviewed exception.
- **Type:** `text-xs` for compact metadata, `text-sm` for body and controls;
  signal emphasis with `font-medium` and `text-fg` instead of inventing display
  sizes inside panels.
- **Shape:** use the softened `rounded-xs` through `rounded-2xl` scale. No
  arbitrary `rounded-[…]` values.
- **Space and layout:** use Tailwind's 4px spacing steps and the workspace
  variables (`--workspace-gutter`, `--workspace-content-max-width`,
  `--workspace-navigation-width`, `--workspace-agents-width`) through the shell
  classes. Do not add magic pixel margins or a second page gutter.
- **Interaction:** every interactive element needs a visible focus ring
  (`focus-visible:ring-1 focus-visible:ring-accent`) and disabled semantics
  (`disabled:opacity-50 disabled:cursor-not-allowed`). Use the global 160ms
  transition rather than per-component durations.
- **Motion:** respect reduced motion
  ([useReducedMotion.ts](../hooks/useReducedMotion.ts)); animation is feedback,
  not decoration.
- **Icons:** `lucide-react` at 12–16px, `aria-hidden` when decorative, or inside
  a control with an accessible name. Icons inherit text tokens; they never
  introduce color of their own.

### 9. Reuse ladder and promotion

Before writing markup, walk this ladder and stop at the first match:

1. **Existing primitive** in [components/ui/](./ui/) — import it directly by
   file path (`@/components/ui/Button`); there is no barrel file.
2. **Existing composition** — for example [PanelHeader.tsx](./ui/PanelHeader.tsx),
   [Dialog.tsx](./ui/Dialog.tsx), [SettingsCard.tsx](./ui/SettingsCard.tsx),
   [TextField.tsx](./ui/TextField.tsx).
3. **Private component** in the owning domain folder, used once.
4. **Promote to `components/ui/`** on the second independent consumer, with a
   co-located test and a semantic name.

Rules:

- **Composition over variants.** Prefer children/slots and small wrappers to
  boolean props. Add a variant only when the visuals are a closed set, as with
  `ButtonVariant` and `ButtonSize`.
- **Extend, do not fork.** If a primitive needs a different look, extend its
  variant or class map; do not create a parallel implementation with its own
  focus, disabled, and theme handling. The duplicated avatar-gradient hash is
  the current counterexample.
- **One owner per decision.** Token values live in
  [app/globals.css](../app/globals.css), primitive class maps in
  [components/ui/](./ui/), and domain status→tone mappings in shared helpers —
  not copied per call site.
- **Props follow the module contract.** Extend native element props, forward
  refs for primitives, use `onX` callbacks, and reserve past-tense
  `onChanged`/`onSaved` for post-success notification.

Common mappings:

| Need | Use | Do not |
| --- | --- | --- |
| Action/button | [Button.tsx](./ui/Button.tsx) variants | a locally styled `<button>` |
| Single-line or multiline text | [TextField.tsx](./ui/TextField.tsx) `TextInput`/`TextArea`; [MarkdownTextarea.tsx](./ui/MarkdownTextarea.tsx) for markdown | raw inputs with custom classes |
| Dropdown | [Select.tsx](./ui/Select.tsx) | a restyled native select |
| Panel title and actions | [PanelHeader.tsx](./ui/PanelHeader.tsx) `PanelHeader`/`HeaderAction` | local header markup |
| Collapsible settings group | [SettingsCard.tsx](./ui/SettingsCard.tsx) `SettingsGroup`/`SettingsCard` | one-off bordered boxes |
| Tabs | [SubTabBar.tsx](./ui/SubTabBar.tsx) | a custom tab list |
| Status | [Badge.tsx](./ui/Badge.tsx), [StatusDot.tsx](./ui/StatusDot.tsx) | colored text |
| Inline or panel feedback | [Notice.tsx](./ui/Notice.tsx), [PanelMessage.tsx](./ui/PanelMessage.tsx) | ad-hoc alert divs |
| Confirmation | `confirmAction()` + [ConfirmHost.tsx](./ui/ConfirmHost.tsx) | `window.confirm` |
| Dialog or editor overlay | [Dialog.tsx](./ui/Dialog.tsx) + [DialogFooter.tsx](./ui/DialogFooter.tsx) | a new portal |
| Sticky footer actions | [StickyActionBar.tsx](./ui/StickyActionBar.tsx) | a fixed-position bar |
| Label/value metadata | [MetaRow.tsx](./ui/MetaRow.tsx) | repeated definition lists |

### 10. Feedback, confirmation, and destructive actions

- Use [ConfirmHost.tsx](./ui/ConfirmHost.tsx) through `confirmAction()` from
  [lib/ui/confirm.ts](../lib/ui/confirm.ts). Do not add `window.confirm`,
  `alert`, or a second modal confirmation path. Destructive confirmations use
  the `danger` variant and focus Cancel first.
- Inline problems use [Notice.tsx](./ui/Notice.tsx); panel-level loading,
  empty, and error states use [PanelMessage.tsx](./ui/PanelMessage.tsx);
  transient success uses the shared toaster. Do not hand-roll alert markup.
- While a mutation is pending, disable the trigger, keep the draft, and show the
  failure next to the action. A 200 response with `ok: false` is a failure for
  the UI.
- Destructive actions name the object and the consequence. Offer a restore path
  when the API supports undo; otherwise make the consequence explicit before
  the request.

## Anti-patterns

- **Direct `fetch`** — some components still call endpoints that are absent
  from the typed client (voice/TTS, redaction, health, update, authoring). This
  is known debt, not a pattern; add the endpoint to `api/client.ts` when
  touching one of these flows. `npm run ui-data:check` ratchets the baseline so
  new direct calls fail lint.
- **Direct `localStorage`** — route browser-only preferences through
  `lib/ui/browser-store.ts`, including theme and experience mode in
  `contexts/`; the UI data-access ratchet treats direct calls as new debt.
  Durable preferences belong in stores.
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
- **Expanding the chat coupling surface** — `ChatView`, `useSSE`, and the chat
  queue still use refs and render-order bridges. Do not add new public methods
  or mirrored refs; split transport, content, and activity responsibilities in
  small steps instead.
- **Forking a primitive** — a local button, field, dialog, or card duplicates
  focus, disabled, and theme behavior and drifts on the next change. Extend the
  shared primitive instead.
- **Ad-hoc design values** — arbitrary colors, radii, spacing, shadows, or
  animation durations bypass the token contract and its contrast targets.
- **A second confirmation system** — local confirm state, `window.confirm`, or
  a bespoke modal instead of `confirmAction()` fragments dismissal and focus
  behavior.
- **Duplicated status logic** — repeating the same badge/tone/label mapping in
  several components; move it to a shared helper or derive it in the
  controller.

## File map

| Area | Contents |
| --- | --- |
| [layout/](./layout/) | App shell, menu, agent switcher |
| [ui/](./ui/) | Shared primitives and their contract tests |
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
- For design-language changes, verify light/dark and keyboard/focus behavior;
  assert roles, labels, and visible feedback, not palette classes or computed
  styles.
- Run the focused component test, `npx tsc --noEmit`, and `npm run lint`.
  `npm run lint:complexity` rejects new oversized function bodies.

## Review checks

- [ ] No persistence/server imports and no new direct `fetch`.
- [ ] Controller owns async work; view stays presentational.
- [ ] All four states render, including failed requests.
- [ ] Shared Dialog/panel/header primitives reused; no forked primitives.
- [ ] Colors, radius, spacing, focus, and motion come from tokens.
- [ ] Destructive flows use `confirmAction()` and name the consequence.
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
