---
status: accepted
date: 2026-05-19
deciders: andwu
consulted:
informed:
---

# HTTPS proxy support and custom CA bundle

## Context and Problem Statement

[ADR-0009](0009-in-app-http-proxy-configuration.md) introduced an in-app
HTTP proxy configuration. The dispatcher always emits `http://` for the
proxy URL and constructs `new EnvHttpProxyAgent()` with no TLS
customisation. Two real-world deployments fail with this shape:

1. **HTTPS-wrapped proxy hop.** Some corporate proxies (Squid behind a
   TLS terminator, Zscaler ZIA in transparent mode, …) require the
   client to speak `https://` to the proxy, not plaintext HTTP. Today
   the user has no way to express that — even if the proxy listens on
   port 443 the dispatcher hardcodes `http://`.
2. **TLS-intercepting proxies (MITM with internal root CA).** Many
   enterprise egress proxies and most mid/large corporate egress points
   re-sign every outbound TLS connection with an internal root. Node
   does not trust that root, so every LLM/MCP call fails with
   `unable to get local issuer certificate` /
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The user can already work around
   this with `NODE_EXTRA_CA_CERTS=/path/to/corp.pem`, but that has the
   same launch-context problem ADR-0009 was created to solve: launchd
   plists, scheduled tasks, and packaged installs don't pick the env
   var up.

How should Jarela let users (a) pick the proxy hop scheme and (b)
inject a custom trust anchor for outbound TLS, without re-introducing
the env-var/launch-context fragility ADR-0009 already eliminated?

## Decision Drivers

* **Same launch-context independence as ADR-0009.** Config must apply
  whether Jarela is started from a terminal, `launchd`, scheduled task,
  or packaged app.
* **Single source of truth.** All proxy configuration lives in
  `proxy_config`. No competing env vars, no separate "trust" file.
* **No new dependencies.** undici's `EnvHttpProxyAgent` already accepts
  the TLS options we need (`requestTls`, `proxyTls`).
* **Public cert is not a secret.** A CA bundle is a public certificate;
  storing it through the [[adr-0005-encrypt-secrets-at-rest]] envelope
  buys nothing and complicates copy-paste / disaster recovery.
* **Smallest UI footprint.** One scheme dropdown + one file picker
  inside the existing Network section, not a separate page.

## Considered Options

* **Option A (chosen):** Add `scheme` (`http` | `https`) and `ca_bundle`
  (PEM TEXT) columns to `proxy_config`. UI presents a scheme select and
  a `.pem`/`.crt` file picker that reads the file client-side and
  submits the parsed text as JSON. Dispatcher passes the PEM into both
  `requestTls.ca` (upstream tunnel after CONNECT) and `proxyTls.ca`
  (proxy hop when scheme=https).
* **Option B:** Document `NODE_EXTRA_CA_CERTS` as the only path. Cheap,
  but defeats ADR-0009's launch-context guarantee — the var won't
  survive a packaged install / scheduled task without user intervention.
* **Option C:** Store the CA bundle as a file path on disk and have the
  dispatcher read it at apply time. Adds a new failure mode (path moves
  / disappears across re-installs and OneDrive re-syncs) and the file
  ends up outside `JARELA_DB_DIR`, breaking the "all state under
  `~/.jarela`" invariant.
* **Option D:** Auto-import the system trust store. Cross-platform
  reliable solutions are heavyweight (e.g. `win-ca`, `mac-ca`, polling
  the macOS keychain) and surface false positives — we'd silently
  trust every cert the OS does, well beyond the proxy's MITM root.
* **Option E:** Store the bundle inside the AES-GCM secret envelope.
  Adds latency and DR complexity for no security gain — the cert is
  public.

## Decision Outcome

**Chosen: Option A.** Two new plaintext columns on `proxy_config`,
two new fields on `ProxyConfigInput`/`Status`, one new branch in
`installProxy`. The dispatcher passes the same PEM blob to both TLS
legs because corporate trust chains in practice sign both the proxy's
own cert and every MITM'd upstream cert — symmetric trust is correct.

### Why same blob to `requestTls` and `proxyTls`

`EnvHttpProxyAgent` exposes two distinct TLS surfaces:

* `proxyTls` — TLS to the proxy hop itself. Relevant when scheme is
  `https`; the proxy presents a cert that must validate.
* `requestTls` — TLS to the upstream target after the proxy issues
  `CONNECT`. Relevant when the proxy MITMs and re-signs the upstream's
  cert with the internal root.

In every corporate setup we've seen, both certs chain to the same
internal root. Asking the user to upload separate bundles for each
leg is a UX trap that buys nothing in the common case. If the rare
"two-CA" deployment surfaces, we can split the field then.

### Why CA bundle is plaintext (not envelope-wrapped)

A CA certificate is, by definition, public — every TLS handshake
broadcasts the chain. The encryption envelope from
[[adr-0005-encrypt-secrets-at-rest]] is for credentials whose
disclosure is itself a compromise (proxy password, API tokens). The
operational cost of envelope-wrapping (KEK availability at boot,
re-encrypt on key rotation, opaque payloads in DB inspection) gains
nothing when the protected data is non-sensitive.

### Why `scheme` defaults to `http`

Empirically, corporate proxies overwhelmingly speak plaintext on the
proxy hop, even when listening on port 443 — the `:443` is a holdover
from "443 punches through firewalls", not a TLS signal. Defaulting to
`http` matches existing behaviour (no breaking change for ADR-0009
deployments) and the rare TLS-wrapped proxy is opt-in via the
dropdown.

## Consequences

* `proxy_config` schema gains `scheme TEXT NOT NULL DEFAULT 'http'`
  and `ca_bundle TEXT`. Migration is additive
  (`ensureProxyConfigSchemeAndCaBundle` in `lib/db/migrations.ts`),
  preserving every existing row.
* `EnvHttpProxyAgent` is constructed with
  `{ requestTls: { ca }, proxyTls: { ca } }` whenever a CA bundle is
  set; otherwise unchanged. No effect when no bundle is configured.
* PEM is validated at the store layer with a `BEGIN CERTIFICATE` sniff;
  full chain validation happens at TLS handshake time and surfaces as
  an upstream call failure (acceptable — the user just uploaded a bad
  file).
* The `system` (scutil) mode keeps `scheme=http` because scutil only
  reports host/port; it still applies the saved `ca_bundle`, since the
  MITM root is independent of how we discovered the proxy.
* No change to the env-vs-DB precedence rule: `ENV_HAD_PROXY_AT_BOOT`
  still wins.

## Pros and Cons of the Options

### Option A — `scheme` + `ca_bundle` columns

* Good, because every state remains under `JARELA_DB_DIR` (ADR-0003,
  ADR-0006).
* Good, because no new dependency — undici exposes the surface natively.
* Good, because rollback is two `ALTER TABLE DROP COLUMN`s away.
* Bad, because storing a CA inline in SQLite is unusual for ops folks
  used to `--cacert /path/to/file`. Mitigated by the `Loaded: file.pem`
  label in the UI.

### Option B — document `NODE_EXTRA_CA_CERTS`

* Good, because zero code change.
* Bad, defeats ADR-0009's whole reason for existing. Launch-context
  fragility re-emerges.

### Option C — file path on disk

* Good, because matches mental model of `--cacert`.
* Bad, because the file lives outside `JARELA_DB_DIR`. Disaster
  recovery (re-install, machine swap) requires the user to remember an
  external file.

### Option D — auto-import system trust

* Good, zero user effort.
* Bad, broad over-trust (every OS-trusted cert), platform-specific
  modules, false positives.

### Option E — envelope-wrap the CA

* Good, internally consistent.
* Bad, no security gain (cert is public). Adds DR complexity.

## More Information

* Implementation: `lib/db/migrations.ts`,
  `lib/stores/proxy-config.ts`, `lib/proxy/dispatcher.ts`,
  `app/api/v1/proxy-config/route.ts`,
  `components/integrations/NetworkSection.tsx`.
* Related: [[adr-0009-in-app-http-proxy-configuration]],
  [[adr-0005-encrypt-secrets-at-rest]],
  [[adr-0003-sqlite-local-persistence]].
* undici docs:
  <https://undici.nodejs.org/#/docs/api/EnvHttpProxyAgent> — the
  `requestTls` / `proxyTls` keys forward straight to Node's
  `tls.SecureContextOptions`, which accepts `ca: string | Buffer | Array<...>`.
