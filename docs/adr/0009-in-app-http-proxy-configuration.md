---
status: accepted
date: 2026-05-19
deciders: example-user
consulted:
informed:
---

# Store HTTP proxy configuration in the encrypted local DB

## Context and Problem Statement

On corporate networks Jarela's outbound `fetch`
calls — to LLM providers, MCP servers, and integration APIs — fail with
`getaddrinfo ENOTFOUND` because the host can only be reached through an
HTTP proxy and/or VPN-pushed DNS. Browsers transparently use the system
proxy via PAC files; Node's `fetch` (undici) only honours
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars.

Today the only way to make Jarela work in this environment is to
`export` proxy vars in `~/.zshrc` and launch from a terminal that
sources it. That breaks down for the supported install paths:

- **`launchd` plists** (`~/Library/LaunchAgents/com.jarela.app.plist`)
  do not source `~/.zshrc`. The agent gets a clean env and DNS fails.
- **Packaged Mac app / Windows scheduled task** likewise inherits a bare
  env.
- The credential is shell-readable: any tool the user runs in that shell
  sees the proxy username/password.

How should Jarela let users configure a proxy in a way that (a) works
across every launch context, (b) doesn't leak credentials in shell
history or process env, and (c) reuses the existing encrypted-at-rest
machinery rather than introducing a parallel secret store?

## Decision Drivers

* **Launch-context independence.** Same config must work whether Jarela
  is started from a terminal, a `launchd` plist, or a packaged `.app`.
* **Reuse [[adr-0005-encrypt-secrets-at-rest]] envelope.** Proxy
  username/password are credentials; they belong in the same crypto
  envelope as integration tokens, not in a new sidecar.
* **No new process or daemon.** Existing repo invariant: single Next.js
  process. Rules out a system-wide proxy injector or `launchd`-managed
  helper.
* **Offline-first.** First launch has no network and must still come up
  cleanly; the proxy is configured *after* the app boots.
* **Discoverable to non-technical users.** A user who can't edit
  `~/.zshrc` should still be able to type host/port/credentials into the
  app and have everything work.
* **macOS system-proxy bridge as a stretch goal.** When the OS already
  knows the proxy (`scutil --proxy`), import it with one click rather
  than making the user re-type.

## Considered Options

* **A. Status quo: env vars only.** Document the `HTTPS_PROXY` workflow
  in the README and update the LaunchAgent plist template to include
  `EnvironmentVariables`.
* **B. Shell wrapper that re-exports `scutil --proxy` at launch.**
  A `scripts/jarela-with-proxy.sh` reads system proxy and `exec`s Node.
  Plist points at the wrapper.
* **C. In-app proxy config persisted to encrypted DB + global undici
  dispatcher.** New `lib/stores/proxy-config.ts`. Settings UI under the
  existing Integrations tab. App boot wires
  `setGlobalDispatcher(new ProxyAgent(...))`. Offers a `system` mode
  that imports from `scutil --proxy` on macOS.
* **D. Option C plus a bundled `proxy-agent` PAC evaluator.** Same as C
  but supports `ProxyAutoConfigURLString` (corporate `.pac` files that
  pick a proxy per host).

## Decision Outcome

Chosen option: **C**, with PAC support (option D) deferred to a follow-up
ADR.

C is the only option that survives every launch context, keeps the
credential off the shell / environment / process listing, and slots into
the existing crypto envelope without a new secret store. The system-mode
import gives corporate Mac users a one-click setup; the manual mode
keeps power users in control.

PAC is out of scope for v1 because:

- It pulls in `proxy-agent` (a noticeably larger dep tree) and a JS
  engine for `.pac` evaluation.
- A single proxy covers the documented workstation scenarios. Per-host
  proxy selection is a corner case we can address if it actually shows
  up.
- The schema reserves a `mode` column; adding `mode = "pac"` later is
  additive.

### Schema

New SQLite table `proxy_config` (single-row, enforced by `id = 1`):

```
id          INTEGER PRIMARY KEY CHECK (id = 1)
mode        TEXT    NOT NULL CHECK (mode IN ('off', 'manual', 'system'))
host        TEXT
port        INTEGER
username    TEXT                  -- plaintext; reveals which user but not the password
password    TEXT                  -- envelope-encrypted via lib/crypto/envelope.ts
no_proxy    TEXT                  -- comma-separated host list
updated_at  TEXT    NOT NULL
```

Reasons for a dedicated table rather than reusing `memory_store`:

- Single-row config is naturally enforced by `CHECK (id = 1)`.
- Schema is read at boot, *before* the encryption migration runs over
  `memory_store`. A standalone table avoids ordering hazards in
  `lib/db/migrations.ts`.
- The non-secret fields (`host`, `port`, `mode`, `no_proxy`) stay
  plaintext for trivial introspection during diagnostics. Only
  `password` goes through the envelope.

### Application

- `lib/proxy/dispatcher.ts` — small module exposing `applyProxyConfig()`.
  Reads the row, builds an `undici` `ProxyAgent`, and calls
  `setGlobalDispatcher()`. `mode = "off"` resets to the default agent.
- Called at app boot from the Next.js server entry, and again from the
  settings save handler so changes take effect without a server
  restart.
- All existing `fetch` call sites (providers, tools, MCP, embeddings)
  inherit the dispatcher; no per-call opt-in. SDK clients are
  constructed per-call inside provider methods (verified in
  `lib/providers/anthropic.ts` and `lib/providers/openai.ts`), so the
  next outbound call after `setGlobalDispatcher` picks up the new
  proxy immediately.

#### Live-swap caveats

The hot-swap is correct for the common case but has two narrow
exceptions, documented here so we don't paper over them:

1. **Already-open long-lived connections** (in-flight SSE streams, MCP
   HTTP-stream sessions, WhatsApp/Telegram bridge sockets) keep the
   dispatcher they were opened with. They reconnect on next attempt
   under the new proxy. A mid-stream chat finishing on the old
   dispatcher is acceptable — it's not a correctness issue.
2. **MCP servers spawned as child processes** inherit env at spawn
   time. v1 does not push proxy config into their env, so this is
   moot today. If a future change does — e.g. proxying an MCP
   server's own outbound calls — the save handler must also bounce
   affected children. Out of scope for v1; called out so it isn't
   silently broken later.

The settings page surfaces a one-line note ("changes apply
immediately to new requests; in-flight streams finish on the old
proxy") so users aren't surprised by exception 1.

### System-mode detection

When `mode = "system"` and `process.platform === "darwin"`, run
`scutil --proxy` once at boot, parse the `HTTPSEnable` / `HTTPSProxy` /
`HTTPSPort` keys, and apply the result. If `scutil` returns no proxy,
behaviour falls back to `mode = "off"`. No detection on Windows / Linux
in v1 — those users select `manual`.

### UI

A new "Network" section inside the existing **Integrations** tab (not a
new top-level tab — keeps the menu lean). Mirrors the integration card
pattern: mode picker, host/port/username/password fields, secret mask
on the password using the existing `SECRET_MASK` sentinel.

## Consequences

* Good, because corporate-network users get a one-time setup that
  survives every launch path.
* Good, because the proxy password is encrypted with the same envelope
  as every other credential, no second secret store.
* Good, because env-var-based configuration still works — the in-DB
  config is additive. Users who prefer `~/.zshrc` are not forced to
  migrate.
* Good, because a `scutil --proxy` import path lowers the configuration
  burden to one click on macOS.
* Bad, because changing the proxy requires opening the app. If the
  proxy is *itself* what's broken, there's no recovery path other than
  setting `HTTPS_PROXY` env var to override.
* Bad, because PAC files are not supported in v1. Users on PAC-only
  corporate networks must extract the right proxy host manually.
* Bad, because we now have a second source of proxy truth (env var +
  DB row). Resolution rule: env var wins if set, DB row otherwise. This
  preserves the existing override path without surprising users.

## Pros and Cons of the Options

### A. Status quo: env vars only

* Good, because zero code change.
* Bad, because `launchd` / packaged-app launches still fail.
* Bad, because the credential lives in shell history and `ps -e`
  visible env.

### B. Shell wrapper exports `scutil --proxy`

* Good, because no app changes; just a plist update.
* Good, because credentials stay in OS keychain (via `scutil`) rather
  than the DB.
* Bad, because it works only on macOS; Windows scheduled-task path
  still needs another solution.
* Bad, because changing networks requires restarting the daemon.
* Bad, because no in-app feedback when the proxy is misconfigured;
  failures surface as opaque `fetch` errors.

### C. In-app proxy config in encrypted DB

* Good, because launch-context independent.
* Good, because reuses the existing crypto envelope.
* Good, because failure surface is in-app and diagnosable (a settings
  page can show "last error: 407 Proxy Authentication Required").
* Bad, because if the proxy is broken at launch, recovery requires the
  env-var escape hatch.

### D. Option C plus PAC evaluator

* Good, because matches browser behaviour exactly.
* Bad, because `proxy-agent` adds a meaningful dep tree we don't
  currently need.
* Neutral: deferrable. The `mode` column reserves space.

## More Information

* Triggered by: an ENOTFOUND incident on a developer machine behind a
  corporate proxy (2026-05-19).
* Builds on [[adr-0005-encrypt-secrets-at-rest]].
* Related: the LaunchAgent plist template and
  `scripts/install-to-system.sh` will gain a one-line note pointing
  users to the in-app config.
* Follow-ups (deferred):
  * PAC support (option D).
  * `scutil --proxy` import on Windows (`netsh winhttp show proxy`)
    and Linux (no standard, would need `gsettings` / per-distro logic).
