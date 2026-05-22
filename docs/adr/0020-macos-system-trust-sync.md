---
status: accepted
date: 2026-05-22
deciders: andwu
consulted:
informed:
---

# macOS system trust auto-sync (keychain → CA bundle)

## Context and Problem Statement

[ADR-0009](0009-in-app-http-proxy-configuration.md) made the proxy URL
configurable from inside the app, and
[ADR-0012](0012-https-proxy-and-custom-ca-bundle.md) added a per-row
`ca_bundle` PEM field for proxies that intercept TLS with an internal
root CA. ADR-0012 explicitly rejected auto-importing the system trust
store as **Option D** because cross-platform solutions are heavyweight
and over-trusting.

In practice, the rejection produced a fragile setup ritual on
macOS behind a TLS-intercepting corporate proxy:

1. Edit `~/.zshrc` to set `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`.
2. `jarela uninstall-service && jarela install-service` from the right
   shell so the LaunchAgent plist captures both vars.
3. Set proxy mode to `system` in the in-app panel.
4. Paste the right CA bundle PEM text into the `ca_bundle` field.

Each step is a chance for drift. A user pasting the **Mozilla** bundle
into step 4 (instead of the corporate bundle that contains the MITM
root) silently breaks every outbound HTTPS — the symptom is
`unable to get local issuer certificate` minutes later, with no clue
that a different file was needed.

But macOS already exposes a single source of truth that corporate MDM
populates: **System Preferences → Network → Proxies** (read by
`scutil --proxy`) and the **System + login keychains** (read by
`/usr/bin/security find-certificate`). We already use `scutil --proxy`
for proxy host/port discovery in `mode=system` (ADR-0009). The remaining
manual paste step is the keychain extraction we deliberately skipped in
ADR-0012.

This ADR revisits Option D for macOS specifically, with a tighter
scope that addresses the original objections.

## Decision Drivers

* **One-click setup on macOS.** A macOS host with corporate roots in the keychain already
  has every CA the enterprise wants trusted. Asking the user to paste
  a PEM file when the OS already knows what to trust is a UX failure.
* **No silent over-trust.** ADR-0012's Option D was rejected for
  trusting "every cert the OS does, well beyond the proxy's MITM
  root." That concern still applies for end-user trust decisions
  (a malicious cert that landed in `login.keychain` could now MITM
  Jarela). We mitigate by:
  * Scoping to **macOS only** in v1, where MDM is the dominant trust
    source on managed devices and the user's own keychain edits are
    rare.
  * **Preserving the manual `ca_bundle` escape hatch** for non-`system`
    modes — if you don't trust the keychain, don't pick `mode=system`.
* **Survives every launch context.** `scutil` and `security` are POSIX
  binaries available regardless of how Jarela was started (terminal,
  launchd, packaged install). No env-var capture trick required.
* **No new runtime dependency.** Two existing CLIs piped through
  `execFileSync` — same shape as the existing `scutil` integration in
  `lib/proxy/dispatcher.ts`.
* **State stays under `JARELA_DB_DIR`.** The extracted bundle is
  written to `<dataDir>/system-ca.pem`, preserving the
  ADR-0003/ADR-0006 invariant that all derived state lives there.

## Considered Options

* **Option A (chosen):** In `mode=system`, run
  `security find-certificate -a -p` against the System +
  SystemRootCertificates + login keychains, dedupe the PEM blocks, and
  write to `<dataDir>/system-ca.pem`. The dispatcher reads that file
  and passes its contents to undici as `requestTls.ca` /
  `proxyTls.ca`. The `jarela install-service` flow does the same
  extraction synchronously and writes the path into the LaunchAgent
  plist as `NODE_EXTRA_CA_CERTS`, so non-undici code paths
  (some provider SDKs, `node-fetch`, …) inherit the trust on next
  service start.
* **Option B:** Status quo — keep ADR-0012's manual paste. Documented
  cause of every TLS support ticket since ADR-0012 shipped.
* **Option C:** Bundle a pinned corporate CA in the app. Out of scope —
  varies per company, and Jarela is single-tenant per developer
  machine.
* **Option D:** Cross-platform via `mac-ca` / `win-ca` / a Linux
  equivalent. Rejected as a v1 scope: macOS unblocks the immediate
  pain (Macs behind a corporate proxy); Linux + Windows can follow with their own
  ADRs once we have a working pattern.
* **Option E:** Watch the keychain with FSEvents and auto-refresh.
  Rejected — keychain rotations are rare (months apart), a manual
  "Refresh trust store" button is enough, and we avoid a long-lived
  watcher in a process that's supposed to be stateless beyond SQLite.

## Decision Outcome

**Chosen: Option A.** Concrete shape:

1. **`lib/proxy/keychain.ts`** — pure helper exporting
   `extractSystemKeychainCAs()` and a stdout-only
   `parseSecurityFindCertificate()` for unit tests. Shells out to
   `/usr/bin/security` with a fixed argv (no shell), dedupes by
   normalised body, and writes the bundle at `chmod 0600`. Non-darwin
   returns `{ error: "macOS-only in v1" }`.
2. **`lib/proxy/dispatcher.ts`** — `applyProxyConfigFromDb()`'s
   `system` branch now calls `extractSystemKeychainCAs()` first and
   uses the resulting PEM as the `ca_bundle` argument to
   `installProxy()`. If extraction fails, it falls back to the
   user-pasted `cfg.ca_bundle` (preserving ADR-0012 behaviour). The
   `ApplyResult` shape gains `caBundlePath`, `caBundleCertCount`, and
   `caBundleSource` so the UI can confirm "187 certs from
   ~/.jarela/system-ca.pem".
3. **`scripts/service-install.mjs`** — new
   `ensureSystemTrustOnDarwin()` runs before `captureProxyEnv()`. If
   the user already set `NODE_EXTRA_CA_CERTS` in their shell, we
   honour that (escape hatch). Otherwise we run the same extraction
   and inject the path into `process.env.NODE_EXTRA_CA_CERTS` so the
   plist carries it forward.
4. **`components/integrations/NetworkSection.tsx`** — when
   `mode === "system"`, hide the manual CA file picker (it would
   conflict with the keychain), show a green "System trust: N certs"
   confirmation row after save, and add a "Refresh trust store"
   button that re-PUTs the same config to re-trigger extraction.

### Why fall back to user-pasted bundle on extraction failure

Two cases hit this path: (a) `security` returns no certs (rare —
SystemRootCertificates is always populated on macOS), or (b) the user
runs `mode=system` on a non-macOS box (we still hit this branch from
the dispatcher; the platform guard lives in `keychain.ts`). Falling
back to whatever the user pasted in ADR-0012's textarea preserves a
working escape hatch and never makes things worse than ADR-0012
already was.

### Why `chmod 0600` on the bundle

The bundle isn't a secret — every cert in it goes out on the wire on
the next TLS handshake — but it lives next to `jarela.db`, which is
0600. Matching permissions reduces the chance of a future audit
flagging the directory as inconsistent. Best-effort: a `chmodSync`
failure is logged and ignored.

### Why no auto-refresh

MDM-pushed cert rotations happen on the order of months. A FSEvents
watcher would add a long-lived background subscription for a vanishing
fraction of installs. The "Refresh trust store" button + the
re-extraction on every `install-service` run cover the common cases
(post-install, after a known MDM push, after a corporate cert
rotation).

## Consequences

* On macOS, `mode=system` now produces a fully self-configured trust
  store. The manual `ca_bundle` textarea is hidden in that mode (still
  available in `mode=manual`).
* The plist generated by `jarela install-service` now contains
  `NODE_EXTRA_CA_CERTS=<dataDir>/system-ca.pem`. Existing installs
  pick this up the next time the user re-runs install-service.
* Disk footprint: one PEM file in `JARELA_DB_DIR` (~200 KB on a internal
  laptop). Regenerated on every `mode=system` apply, so it stays
  fresh without manual intervention.
* **Live-swap caveat.** Node's `NODE_EXTRA_CA_CERTS` is read once at
  process start. The dispatcher hot-swap covers undici-backed code
  (the bulk of provider/MCP/integration calls), but provider SDKs
  using `node:https` directly only see the new bundle after a service
  restart. The dispatcher includes a `note:` advising restart for
  non-undici code paths.
* **Linux / Windows are out of scope for v1.** A future ADR can extend
  this with `update-ca-certificates` (Linux) and `certutil -store
  ROOT` (Windows). The dispatcher branch reads the result-shape, not
  the OS, so adding new sources is additive.
* **Rollback** is one git revert away — the SQLite schema is
  unchanged.

## Pros and Cons of the Options

### Option A — macOS scutil + keychain auto-sync

* Good, because zero manual paste on the supported platform.
* Good, because the OS is already the source of truth for managed
  Macs (MDM populates the keychain).
* Good, because preserves the manual paste escape hatch for users
  who don't want OS-level trust delegation.
* Bad, because v1 is macOS-only — Linux/Windows users still paste.

### Option B — status quo

* Good, zero code change.
* Bad, every Mac behind a corporate proxy re-discovers the same trap on first
  install.

### Option C — bundle a pinned corporate CA

* Good, deterministic for one company.
* Bad, doesn't generalise — Jarela ships to many users at many
  companies.

### Option D — cross-platform via mac-ca / win-ca

* Good, single conceptual model across OSes.
* Bad, three new dependencies and three ways to be wrong; macOS-only
  v1 is faster to ship and validates the pattern.

### Option E — FSEvents auto-refresh

* Good, zero user action after rotations.
* Bad, complexity and lifetime risk for a refresh that's needed once
  every few months.

## More Information

* Implementation: `lib/proxy/keychain.ts`, `lib/proxy/dispatcher.ts`,
  `scripts/service-install.mjs`,
  `components/integrations/NetworkSection.tsx`,
  `api/types.ts` (extended `ProxyApplyResult`).
* Related: [[adr-0009-in-app-http-proxy-configuration]],
  [[adr-0012-https-proxy-and-custom-ca-bundle]],
  [[adr-0003-sqlite-local-persistence]],
  [[adr-0006-windows-state-dir-localappdata]],
  [[adr-0016-env-sync-from-shell-rc]].
* macOS man pages: `security(1)` — `find-certificate -a -p`,
  `scutil(8)` — `--proxy`.
* Node docs: `tls.SecureContextOptions.ca` accepts `string | Buffer |
  Array<...>` — same signature undici forwards through
  `requestTls`/`proxyTls`.
