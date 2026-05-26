---
status: "accepted"
date: 2026-05-25
deciders: example-user
---

# Per-tool encrypted secret slots for external tools

## Context and Problem Statement

ADR-0013 defined the external tool contract (`module.exports = { name,
description, schema, run }`) but gave authors no Jarela-provided place to
store credentials. The honest options reduced to:

1. Read `process.env.MY_TOOL_KEY` — forces operators to edit systemd units /
   shell rc files / Docker run commands, and the secret sits in plaintext in
   every child process's environment.
2. Roll a private config file under `~/.jarela/tools/<name>.json` — works,
   but leaves secrets on disk in plaintext while Jarela's own integrations
   are AES-256-GCM enveloped (ADR-0005). The two trust levels are
   inconsistent.
3. Reach into `@/lib/stores/integrations` from the extension — couples the
   tool to Jarela internals and silently breaks across refactors.

We want a first-class place for external tools to store credentials,
encrypted at rest with the same primitive Jarela uses for its own
integrations, editable from the Extensions panel.

## Decision Drivers

* Authors writing a plain `.cjs` should be able to declare which credentials
  the tool needs and read them at runtime without importing anything
  Jarela-specific.
* Secrets must be encrypted at rest using the existing envelope primitive
  (`lib/crypto/envelope.ts`), not invent a parallel format.
* Plaintext must never reach the client. The UI sees `is_set: boolean` and
  the masked sentinel `"********"` only.
* Per-tool scoping must hold *by API*. Cross-tool access by a malicious
  in-process extension is out of scope — same trust model as ADR-0013.
* The slot declaration must be optional and backwards-compatible. Existing
  tools without `secrets:` continue to work unchanged.

## Considered Options

* **A — Declared slots + `ctx.getSecret`.** Tool exports an optional
  `secrets: Array<{ key, label?, required?, description? }>`. Loader binds
  `ctx.getSecret(key)` per-tool. Storage is the `tool-secrets` memory
  namespace (added to `SENSITIVE_MEMORY_NAMESPACES` so the existing crypto
  migration applies). One new REST endpoint
  (`/api/v1/extensions/tools/:name/secrets`) for UI editing.
* **B — Reuse the integrations contract.** Treat each external tool as an
  "integration". Forces the tool author to also register an integration
  manifest, which is design-time only and not hot-reload-friendly.
* **C — Generic key-value secret store with no per-tool scoping.** Smallest
  surface, but loses the "this tool needs these slots" UX the Extensions
  panel benefits from, and any tool could read any other tool's secrets via
  the same helper.

## Decision Outcome

Chosen option: **A — Declared slots + `ctx.getSecret`.** Adds ~150 lines
across the loader, a new store wrapper, one route, and a panel section.

### Consequences

* Tool authors get a clean, optional addition to the contract: declare what
  you need, read it via `ctx.getSecret("api_key")`.
* Operators get one place to configure tool credentials, mirroring the
  existing Integrations panel.
* The plaintext blast radius is unchanged from ADR-0013: anything running
  in the Jarela process can ultimately read anything else. The per-tool
  scoping of `ctx.getSecret` is a convention surfaced through the loader,
  not a sandbox.
* `tool-secrets` joins `integrations` and `github-copilot-auth` in
  `SENSITIVE_MEMORY_NAMESPACES`, so the existing one-time encryption
  migration (ADR-0005) covers it for free.

### Storage layout

* Memory namespace: `tool-secrets`
* Row key format: `<toolName>:<slotKey>`
* Value: JSON-encoded string, envelope-encrypted at rest
* Validation: `toolName` and `slotKey` both match `^[a-z0-9_-]+$/i`, length
  ≤ 64.

### Wire shape

`GET /api/v1/extensions` includes per-tool `secrets: Array<{ key, label?,
required?, description?, is_set }>`. Plaintext is never returned.

`GET /api/v1/extensions/tools/:name/secrets` returns the same shape for one
tool.

`PUT /api/v1/extensions/tools/:name/secrets` body `{ values: { [key]: string } }`:
empty string deletes the slot; `"********"` is treated as "leave unchanged"
so the UI can echo back the masked form without blanking saved values.
Slots not declared by the tool are rejected.

## Limitations

* No rotation, expiry, or audit log — those are tracked separately as
  follow-up improvements alongside the integration store.
* External tools sharing the Node process can still read each other's
  secrets by going around `ctx.getSecret` (e.g. opening the SQLite file
  directly). Treat third-party extensions as you would locally-installed
  MCP servers.
