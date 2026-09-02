---
status: "accepted"
date: 2026-09-02
deciders: example-user
consulted:
informed:
---

# Tools declare their backing integration

## Context and Problem Statement

The model is shown a tool catalogue on every turn. Until now that catalogue
included tools the operator had never finished setting up: a Gmail-less
install still advertised `gmail_search`, and a drop-in tool declaring
`credentials_required: ["TAVILY_API_KEY"]` was offered whether or not the key
existed. The agent would pick the tool, the call would fail at the auth layer,
and the turn was wasted. Worse, the failure looked like a broken tool rather
than an unfinished setup.

Two half-mechanisms already existed:

* `lib/tools/langchain-packages.ts` skips loading a package whose
  `requiredEnv` is unset, so those tools never enter the catalogue. This is
  the behaviour we want, but it only covers manifest-loaded packages.
* `credentials_required` on drop-in and MCP tools was pure metadata. It drove
  a key icon in the agent editor and nothing else.

Neither covers the in-tree integration tools (Gmail, Outlook, Google Calendar,
Microsoft Graph, To Do), which resolve credentials at call time and are always
present in the catalogue.

Filtering those requires knowing which integration backs a tool, and that
relationship did not exist anywhere:

* Integration manifests (`lib/integrations/*/manifest.ts`) describe setup
  steps, not tools.
* Tools carry only a `category`. `Atlassian` → `atlassian` and `GitHub` →
  `github` would work by string normalisation, but `JiraAlign` does not match
  `jira_align`, and `Mail` is ambiguous across three integrations (`gmail`,
  `outlook`, `icloud`).

Deriving the mapping from the category string was therefore not viable.

## Decision Drivers

* The catalogue is rebuilt on every turn, so no gate may block on the network.
* A flaky network must not make an agent's toolset vanish mid-conversation.
* The mapping must be explicit; guessing from category names is wrong for at
  least two of the seven integrations.
* No new persistence: `~/.jarela` schema changes carry migration cost that a
  cache does not justify.

## Considered Options

1. **Derive integration from tool category.** Rejected — ambiguous for `Mail`,
   wrong for `JiraAlign`.
2. **Probe synchronously during catalogue build.** Rejected — puts N network
   round-trips in front of every agent message.
3. **Persist probe results in SQLite.** Rejected for now — survives restarts
   and would feed the UI, but needs a migration for state that is cheap to
   recompute and stale within minutes.
4. **Declare the integration on the tool, cache probe results in memory.**
   Chosen.

## Decision Outcome

Tools may declare the INTEGRATIONS key that backs them, and the catalogue
hides a tool when either its declared credentials are missing or a cached
probe reports the integration is unconfigured.

### Contract

`registerTools(category, capability, tools, integration?)` takes an optional
integration id. It is normally supplied via `registerLangChainPackage`:

```ts
registerLangChainPackage({
  category: "Mail",
  integrationId: "gmail",
  tools: { read: [...], write: [...], execute: [...] },
});
```

`integrationId` defaults to `auth.integrationId` when the package uses the
auth bridge, so the four workspace packages (`atlassian`, `github`,
`jira_align`, `icloud`) needed no change. Drop-in tools declare
`integration: "<id>"` in their module export; MCP tools declare it in
`annotations`.

`ToolCatalogEntry` gains `integration: string | null`.

### Gating

`getAllToolCatalogAsync()` downgrades an otherwise-enabled entry to
`status: "unavailable"` with:

* `status_reason: "credentials_missing"` — a key in `credentials_required` is
  absent from both `process.env` and the env-sync allowlist. This mirrors the
  resolution order the package loader already uses for `requiredEnv`, so
  credentials saved through the Integrations panel count as present.
* `status_reason: "integration_unconfigured"` — the cached probe for the
  declared integration returned `unconfigured` or `auth_failed`.

### Readiness cache

`lib/health/probe-cache.ts` holds an in-memory map with a 5-minute TTL. Reads
are synchronous. A miss reports `unknown` and schedules a background probe;
the result is picked up by a later turn.

Three properties matter:

* **`unknown` never hides a tool.** A cold cache is indistinguishable from a
  healthy one, so a restart cannot silently strip an agent's tools.
* **`transient` and `error` never hide a tool.** Only `unconfigured` and
  `auth_failed` do — a rate limit or DNS blip is not a setup problem.
* **Background refresh is disabled under `NODE_ENV=test`** so unit tests stay
  hermetic, with `_setIntegrationReadiness()` as the seam.

## Consequences

Good:

* The model stops being offered capabilities the install cannot perform.
* `credentials_required` becomes load-bearing instead of decorative.
* The tool → integration edge is now explicit and reusable — the Integrations
  panel can use it to show which tools a credential unlocks.

Bad / accepted:

* Readiness is lost on restart, and the first turn after a restart sees
  `unknown` for every integration. Acceptable because `unknown` is the
  permissive value.
* An operator who revokes a token sees the tools disappear up to five minutes
  later, not immediately. `invalidateIntegrationReadiness()` exists for
  credential-write paths that want to force a re-probe.
* Integrations without a probe (`isIntegrationProbe` is false) are never
  gated on readiness; they still gate on `credentials_required`.
