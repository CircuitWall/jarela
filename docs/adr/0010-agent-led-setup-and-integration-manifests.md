---
status: accepted
date: 2026-05-19
deciders: example-user
consulted:
informed:
---

# Agent-led setup with declarative integration manifests

## Context and Problem Statement

A non-technical user installing Jarela today has to clear several
configuration walls before the app does anything useful: get an LLM API
key, paste it into settings, pick a model, then — if they want any real
power — install MCPs, connect Gmail/Outlook/Calendar, configure proxy,
choose tool allowlists, etc. Each step has its own UI, its own
vocabulary, and its own failure modes. Most users will bounce before
they reach the second screen.

The insight from product discussion (2026-05-19): the only step that
*must* be a static UI is the **first** GenAI API key — without it there
is no agent to help. Once one model is alive, the agent itself is the
most natural onboarding surface: it can answer "how do I connect
Gmail?", run preflight checks, and — with the user's approval —
actually perform the setup. Today the agent can only describe steps; it
cannot *do* them safely, and it does not know which integrations exist
or what they need.

How should Jarela structure setup so that (a) only the first API key
requires a static screen, (b) the agent can drive the rest with
user-approved actions, (c) integrations added in the future
automatically participate without bespoke UI work, and (d) the agent
cannot be talked into reconfiguring the system by content it reads
during a task?

## Decision Drivers

* **One-screen barrier.** The pre-agent setup flow must collapse to
  exactly one screen: provider, key, model, test. Everything else is
  reachable through conversation.
* **Build on the existing approval rail.** [[propose_config_change]] +
  `pending_actions` already implements queue → user-visible diff →
  approve/deny → apply. New privileged operations should plug into
  this rail, not invent a parallel one.
* **Prompt-injection containment.** Tools that fetch external content
  (web pages, emails, MCP outputs) can carry adversarial instructions.
  Any change to settings, credentials, MCPs, or tool allowlists must
  surface as an explicit user decision — never an auto-applied tool
  call — so a malicious page cannot reconfigure the machine.
* **Discoverability without web search.** The agent must answer
  "how do I set up X?" from local, vendored docs. A user without
  internet, or behind a corporate proxy that hasn't been configured
  yet, must still get help.
* **No drift.** A new integration shipped six months from now should
  be discoverable to the agent the day it lands, without anyone
  remembering to update a separate index.
* **Self-documenting source of truth.** Setup steps should live next
  to the integration code, not in a separate doc that decays.

## Considered Options

* **A. Status quo + better README.** Keep all setup in static UI; rely
  on README and tooltips. Agent has no role.
* **B. Free-form agent help, no manifests.** Add a system prompt
  section listing integrations and their steps as prose. Agent can
  describe but cannot do — user still clicks through every UI.
* **C. Declarative manifest per integration + extend
  `propose_config_change` with new kinds.** Each integration ships a
  `manifest.ts` with: machine-readable setup steps, prerequisite
  checks, error catalog, and the list of pending-action kinds the
  agent may propose. Agent has a `list_integrations` /
  `get_integration_setup` tool that reads manifests and a
  `propose_config_change` extended with `start_oauth`,
  `set_provider_key`, `enable_integration`. User approves each step.
* **D. Full automation behind a "setup mode" session.** During an
  onboarding session, agent applies changes without confirmation.
  Confirmation re-enables after setup completes.

## Decision Outcome

Chosen option: **C**.

C is the only option that gives the agent enough context to *help*
without giving it enough authority to *harm*. The pending-actions
rail already exists and has been validated for MCP installs and tool
edits; extending it is additive. Manifests collocate setup
documentation with the integration code, so adding an integration in
the future automatically makes it discoverable to the agent — no
separate index to forget to update. Option D is rejected outright:
prompt-injection-driven misconfiguration is the exact threat the
approval rail exists to prevent, and lifting it in any session is
unsafe.

### First-key screen (the one static wall)

A new pre-agent route `/setup` that runs when no provider key is
configured. Three fields, one button:

1. **Provider** (Anthropic / OpenAI / Google / Cohere)
2. **API key** (validated against the provider's models endpoint
   before save — same pattern as the existing settings page)
3. **Default model** (populated from the validated `models` response
   so the user picks from a real list, not a free-form string)

Errors must be specific: "this looks like an OpenAI key but you
selected Anthropic", "rate-limited — retry in N s",
"network unreachable — proxy may be needed, see
[[adr-0009-in-app-http-proxy-configuration]]". An "I don't have a
key yet" link opens each provider's signup page in a new tab.

This screen is the *only* mandatory step. Once it succeeds, the user
lands in chat; everything else is reachable through the agent.

### Integration manifest contract

Every integration under `lib/integrations/<name>/` must export a
`manifest` from `manifest.ts`:

```ts
export interface IntegrationManifest {
  /** Stable id, kebab-case. Matches the directory name. */
  id: string;
  /** Human-friendly name for UI and agent dialogue. */
  name: string;
  /** One-paragraph description, agent-readable. */
  summary: string;

  /** What the user needs before the agent can help. */
  prerequisites: Array<{
    check: "provider_key" | "oauth_app" | "env" | "custom";
    detail: string;        // human-readable, agent-readable
    docs_url?: string;     // vendor doc, opened on user click only
  }>;

  /** Ordered, agent-narratable setup steps. */
  steps: Array<{
    id: string;
    title: string;         // shown to user
    description: string;   // agent-readable, ≤2 sentences
    /** Which propose_config_change kind (if any) implements this step. */
    proposes?: PendingActionKind;
    /** A self-test the agent can run after the step to confirm success. */
    verify?: { tool: string; args?: Record<string, unknown> };
  }>;

  /** Common failures and the recovery hint the agent should offer. */
  troubleshooting: Array<{
    when: string;          // pattern or condition
    say: string;           // agent guidance
  }>;
}
```

Manifests are vendored TypeScript, not fetched. They are the
authoritative source of setup docs; the README links to a generated
index built from them at build time (see Follow-ups).

A linter (extends existing `npm run lint`) fails the build if any
directory under `lib/integrations/` lacks a `manifest.ts` whose
default export passes a zod schema validation. This is the
enforcement teeth that prevents drift.

### Extended `propose_config_change` kinds

`ActionKind` in [[lib/stores/pending-actions.ts]] gains:

| Kind | Payload | What approval applies |
|------|---------|----------------------|
| `start_oauth` | `{ provider: "google" \| "microsoft" \| ..., scopes: string[] }` | Opens the in-app OAuth flow with the requested scopes. User sees scopes before consent. |
| `set_provider_key` | `{ provider, key_preview }` | Replaces / adds an LLM provider key. The actual key is collected through a one-time secure prompt UI, never passed via the agent's tool args. |
| `enable_integration` | `{ id }` | Flips an integration to enabled and registers its tools. Pre-checks prerequisites from the manifest. |

`set_provider_key`'s payload deliberately does **not** carry the key
itself: the approval UI renders a secret input field and the user
pastes the key directly into the trusted DOM. This closes the
prompt-injection vector where an adversarial page could trick the
agent into proposing a key it controls.

### Agent-side tools

Two new read-only tools, plus the existing `propose_config_change`:

* `list_integrations` — returns `{ id, name, summary, status }[]` for
  every manifest. No arguments.
* `get_integration_setup(id)` — returns the full manifest for one
  integration, plus current status (which steps are already done,
  inferred from the integrations store).

These are read-only and safe to call freely. The agent's system
prompt is updated to describe the
"user asks how to connect X → call `get_integration_setup` →
narrate the steps → propose actions one at a time" loop.

### URL opening — decided against a generic `open_url` tool

A natural-seeming follow-on is "give the agent an `open_url(url)` tool
so it can pop the user straight to a signup or setup page." We
considered this and **rejected it**. The combination below already
covers every legitimate case, and an unrestricted `open_url` would
hand the agent a phishing-grade primitive:

* **Markdown links in chat.** `react-markdown` already renders
  `[label](url)` in agent output. The user clicks, the browser
  opens, the URL bar is visible — the existing trust model.
* **Manifest-rendered buttons.** For high-traffic destinations
  (provider signup, vendor docs), the `docs_url` field on a
  manifest step renders as a button next to the step the agent is
  narrating. Crucially, the button is rendered by the *manifest
  UI*, not by the agent's tool call — the URL set is finite,
  vendored, and code-reviewed.
* **OAuth.** Already covered by the `start_oauth` pending action.
  Approval opens the real consent screen with the right scopes;
  the agent never names the URL.

The threat we are avoiding: an adversarial page or email read during
a task instructs the agent — "tell the user to click here to fix
their account" — with a phishing URL. With `open_url`, the agent
pushes a new tab and many users will trust it. Without it, the
agent must either (a) emit a markdown link the user actively clicks
(URL visible) or (b) reference a manifest step (URL is vendored).
Both keep the user in the verification loop.

This is recorded explicitly so the next person to think
"the agent should just open the link for them" sees the reasoning
before reopening the question.

### What stays in static UI

* The first-key screen (above).
* The Integrations panel for users who prefer clicking. Manifests
  drive its rendering too — same source of truth, two front-ends.
* Approval cards in chat for any pending action. The visual diff is
  the user's last line of defense.

## Consequences

* Good, because pre-agent setup collapses to one screen; everything
  else is conversational.
* Good, because every future integration ships its setup docs as
  code, automatically discoverable to the agent and to a
  build-time-generated README index.
* Good, because the existing `pending_actions` rail is reused — the
  privilege-and-confirmation surface stays small, auditable, and in
  one place.
* Good, because the `set_provider_key` flow keeps the actual secret
  out of the agent's context entirely, mitigating both prompt
  injection and accidental logging.
* Bad, because every new integration now has a manifest authoring
  cost. Mitigated by a template + lint, but still real.
* Bad, because the agent's quality of help is bounded by manifest
  quality. A sloppy manifest produces sloppy guidance. We accept
  this — it's no worse than today's prose docs, and at least it's
  reviewable in PRs.
* Bad, because users who *don't* read the approval cards may approve
  blindly. The cards must show concrete diffs (scopes requested,
  tools added, MCP spec) — not just "agent wants to do X".

## Pros and Cons of the Options

### A. Status quo + better README

* Good, because zero code change.
* Bad, because the second-screen drop-off problem is unchanged.
* Bad, because the agent can't help with setup at all.

### B. Free-form agent help, no manifests

* Good, because cheapest agent-side change — a system-prompt edit.
* Bad, because the agent can describe but not do, so the user still
  clicks through every UI; setup time barely improves.
* Bad, because integration knowledge lives in a system prompt that
  has to be hand-edited each time an integration ships — high drift
  risk.
* Bad, because no machine-checkable contract; new integrations can
  silently miss setup docs.

### C. Manifests + extended `propose_config_change`

* Good, because lint enforces the contract; drift is structurally
  prevented.
* Good, because reuses the existing approval rail — no new
  privilege surface.
* Good, because the same manifest powers both the agent and the
  static Integrations panel.
* Bad, because authoring cost per integration.

### D. Full automation in a setup-mode session

* Good, because fastest possible onboarding.
* Bad, because prompt-injection risk is unacceptable: any tool
  output during the session can rewrite settings.
* Bad, because the security model becomes session-mode-dependent —
  hard to reason about, easy to mis-implement.

## More Information

* Builds on the existing approval pattern in
  [[lib/stores/pending-actions.ts]] and
  [[lib/tools/propose.ts]].
* Related: [[adr-0009-in-app-http-proxy-configuration]] — the
  first-key screen must surface proxy errors clearly so corporate
  users land in the proxy config flow.
* Follow-ups (deferred):
  * Build-time generator that walks `lib/integrations/*/manifest.ts`
    and writes a section into `README.md` and a single page in
    `ARCHITECTURE.md`. Replaces hand-maintained integration lists.
  * `lib/integrations/_template/` skeleton + `npm run new:integration`
    scaffolding so the manifest is filled in by default.
  * Manifest schema versioning. v1 is unversioned; once external
    contributors land integrations we'll add a `manifestVersion`
    field and a compat layer.
  * Telemetry-free success metric: track the count of completed
    `enable_integration` proposals locally so the user can see "you
    have 3 integrations connected" without anything leaving the
    machine.
