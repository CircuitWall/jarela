---
name: jarela-integrations
description: "Use when: choosing, setting up, diagnosing, or extending a Jarela integration, connector, provider, or MCP connection."
---

# Jarela Integrations

Use this skill when the user wants to add, configure, debug, or extend an
integration in Jarela.

## Input

The requested capability, configured integration, non-secret setup status,
available typed tools and explicit scope for local/vendor changes.

## Output

A verified connection/capability, a pending consent or approval, or a diagnosis
with missing prerequisites and a recovery step. Distinguish configuration saved,
authentication working and the requested operation actually succeeding.

## Validation

Read back configuration and use an available read-only probe under existing
permissions. A mocked adapter test does not prove a live account works; a
successful probe does not prove all scopes or write operations. Never send or
modify external data merely to test setup without authorization. Stop on denial
or cancellation. An uncertain external write needs read-back/reconciliation,
not an automatic retry. Missing credentials belong in credential UI, not chat.

## Choose The Integration Path

1. Native/built-in integration: use the existing manifest and typed tools.
2. External LLM provider: add a `.cjs` provider plugin under the configured
   providers directory.
3. External tool: add a `.cjs` tool under the configured tools directory.
4. MCP server: configure a stdio or HTTP MCP server.
5. Built-in code integration: add an in-tree package/tool/provider when the
   integration should ship with Jarela.

Call `describe_extension_surfaces` when unsure which path fits.
For a genuinely missing, authorized capability, load `extension-development`
before scaffolding. Keep generated drafts outside auto-loaded directories;
tests and installation need separate authority. Upstream sharing is optional:
load `contribution-review` only for an explicitly requested contribution.

## Setup Flow For Users

1. Call `list_integrations` to see configured and available integrations.
2. Call `get_integration_setup(id)` for the chosen integration.
3. Walk the user through prerequisites and credential fields.
4. Use `propose_config_change` for setup actions that require approval.
5. Never put API keys, OAuth tokens, client secrets, passwords, or private keys
   in proposal payloads or chat text.
6. After approval, run the relevant test/probe tool or integration test endpoint
   if available.

## Adding A Built-In Integration

- Add or update the manifest under `lib/integrations/`.
- Add typed tools under `lib/tools/` or a package under `packages/` and register
  with `registerLangChainPackage`.
- Add the side-effect import in `lib/tools/runtime/builtins.ts` when adding a new built-in
  tool module.
- Register network/external-resource tools with explicit capabilities and enforce
  the applicable permission policy; credentials alone are not authorization.
- External packages/plugins can execute with full host privileges on import or
  installation. Do not import unknown code just to inspect it or claim capability
  metadata is a sandbox.
- Add tests for the manifest, credential probe path, and at least one happy-path
  tool invocation or mocked adapter call.
- Document the setup path in user-facing docs when the integration needs manual
  external configuration.

## Debug Checklist

- Is the credential row present and configured?
- Is the outcome an access denial, missing setup, or a transient outage?
  Complete only authorized setup; do not change policy or author a workaround
  for denied access. Retry a read-only transient probe at most once.
- Does `list_tools` show the expected tool name?
- Is the tool category disabled?
- Is the MCP server enabled and connected?
- Does the integration probe fail with auth, network/proxy, missing scope, or
  provider-specific validation?
- Are multiple credentials configured, and does the agent/tool have the intended
  credential override?
- Is a skill dependency being confused with an integration? Reading shared
  skill metadata or script source does not install code, approve it or enable
  checked execution. Discover the installed tool schemas and stop when execution
  is unavailable; never bypass a denied skill boundary through a plugin or shell.

## Preferred Agent Behavior

- Prefer typed Jarela tools over shell CLIs like `gh`, `jira`, or `aws` when a
  typed integration is configured.
- Be explicit about whether an action is local setup, vendor setup, OAuth
  consent, or a Jarela approval.
- Skill checksum trust, if installed, is a separate local-user Security decision
  scoped to a verified revision, agent/workspace and limits. It is not OAuth
  consent or permission to expose credentials to full-trust scripts.
- Validate after saving credentials or changing integration configuration.
- For multi-stage setup or diagnosis, use `workflow_progress` with prerequisites → approval/consent → configuration → probe. Skip simple credential-status questions.
- Keep one stable, task-specific `workflow_id` and send the complete current item list on each update. Never put credentials, OAuth codes, or private values in workflow fields.
- Give each checklist item explicit `input`, `output` and `validation`.
  Keep approval and consent items `needs_attention` with `needs_user: true`
  until confirmed. Mark `done` only with observed `validation_evidence`, not
  merely because a proposal was created or a tool exited successfully.
