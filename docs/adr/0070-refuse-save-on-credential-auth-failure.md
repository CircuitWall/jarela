# 0070 – Refuse to persist a credential that the vendor already rejects

- Status: accepted
- Date: 2026-08-01

## Context

Under the previous flow, saving a credential in the UI was a pure
write: `POST /api/v1/credentials` or `PUT /api/v1/credentials/[id]`
stored the (encrypted) params and returned success. The failure of a
dead token — expired API key, revoked OAuth token, wrong tenant URL —
only surfaced later:

- The `useCredentialProbes` hook fired an `integrations.test` call on
  the next Credentials panel mount and painted the row red.
- The scheduler-driven health sweep (every ~10 min, ADR-0064) picked
  it up on the next tick and published a `health_alert` notification.
- The actual chat turn that tried to use the credential threw with a
  raw provider error (`401 API_KEY_INVALID`), which — after Phase 4
  (ADR-0068) — surfaces as a deep-link banner in the chat view.

All three signals arrive *after* the operator has already dismissed
the Save dialog. In the meantime a race window exists where an agent
autonomously fires the credential (a scheduled task, a bridge, a
watcher) and the run fails silently — now visibly, thanks to ADR-0069,
but still needlessly.

## Decision

**Probe the credential synchronously inside the save endpoint.**

- `POST /api/v1/credentials`: after `createCredential`, if the provider
  has an integration probe registered (`isIntegrationProbe`), invoke
  `runProbe(provider)` inside `runWithToolCredentialContext` bound to
  the freshly-created row. On `status === "auth_failed"`, roll back
  by `deleteCredential(id)` and return `400 { error, code:
  "auth_failed" }` with the vendor's rejection message.
- `PUT /api/v1/credentials/[id]`: same probe, but on `auth_failed`
  roll back to the pre-edit params (so a botched edit doesn't clobber
  the previously-working secret) and return the same 400.
- Both routes accept `?force=1` to bypass the probe — for cases where
  the operator has already read the error and consciously wants to
  persist the row anyway (e.g. the vendor is transiently down at save
  time, or the operator is uploading credentials for a service they
  will unlock later).

Only `auth_failed` triggers refuse-save. `transient` / `error` /
`unconfigured` pass through unchanged — those aren't user-fault
conditions, just probe noise.

## Scope: integration credentials only

The refuse-save probe currently applies **only to integration
providers** (`atlassian`, `github`, `gmail`, `outlook`, `icloud`,
`jira_align`). LLM-provider probes
(`probeAnthropic`/`probeOpenAI`/…) read from
`getIntegrationRaw("anthropic")` rather than from the credentials
table, so probing them after a `POST /credentials` write would test
whatever value is live in the integrations store, not the freshly-
written credential row. Adding a `resolveIntegrationCredential`-style
override to the LLM probes is a separate change (deferred).

For LLM credentials the existing `useCredentialProbes` hook (running
in the panel) still probes the value on next mount, so an operator
who saved a dead OpenAI key still sees the red X immediately — just
not at the Save button.

## Consequences

- **Wins:** Bad integration credentials are impossible to persist
  without a conscious `?force=1` override. Operators discover typos
  and expired tokens at Save-time, not on the next agent turn.
  Combined with ADR-0068 (banner) and ADR-0069 (run_error rows), the
  three failure modes — save, run, background — are now all
  observable and cross-referenced by `credential_id`.
- **Trade-off:** Every save now waits on a vendor round-trip. Bounded
  by `DEFAULT_PROBE_TIMEOUT_MS` (15 s). Acceptable — the vendor is
  about to be used anyway; if we can't reach it, refusing the save
  is the right default. `?force=1` provides the escape hatch.
- **Trade-off:** Two probes fire in quick succession on the very
  first save (the refuse-save probe, then `useCredentialProbes` on
  the next mount). Both hit the same "myself" endpoint; the second
  one benefits from any HTTP keep-alive but is otherwise duplicated
  work. Not worth deduping until it becomes a measurable pain.

## Alternatives considered

- **Fire-and-forget probe after save**, surfacing the result via a
  toast. Rejected — the write is atomic from the operator's
  perspective, and finding the toast in the notifications drawer is
  strictly worse UX than the modal error at the Save button.
- **Client-side probe pre-save.** Rejected — the browser can't call
  vendor APIs without CORS, and duplicating the probe logic in the
  UI would drift from the server's authoritative check.
- **Refuse-save based on `transient` / `error` too.** Rejected — a
  vendor being temporarily unreachable shouldn't block a save; the
  scheduler will pick up the recovery. Only `auth_failed` (401/403
  with a body that matches the auth-error regex) is a rejection the
  operator can act on.
