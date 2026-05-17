# 5. Encrypt secrets at rest with an OS-keychain-derived master key

Date: 2026-05-17

## Status

Accepted

## Context

ADR-0003 commits Jarela to SQLite local persistence at `${JARELA_DB_DIR}`
(default `~/.jarela`). Today every secret-bearing value in that directory
is stored in plaintext:

| Surface                                                    | Plaintext contents                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `memory_store` namespace=`integrations`                    | Gmail OAuth refresh token + client secret; Atlassian API token; Gemini / Imagen API key |
| `model_configs.params`                                     | API keys for every configured LLM provider (Anthropic, OpenAI, Gemini, DeepSeek, Cohere) |
| `mcp_servers.spec.env`                                     | MCP env vars: `GITHUB_TOKEN`, `GOOGLE_MAPS_API_KEY`, `BRAVE_API_KEY`, Postgres URLs, …    |
| `memory_store` namespace=`github-copilot-auth`             | GitHub Copilot device-flow OAuth token                                                   |
| `${JARELA_DB_DIR}/baileys/<bridge_id>/` (filesystem)       | Baileys multi-device auth state — full WhatsApp session                                  |

Read access is synchronous from ~22 call sites across providers, tools,
agents, MCP, and embeddings.

Two concrete incidents motivated this change:

1. During the day-1–3 journal screenshot pass, inspection scripts that
   `SELECT * FROM memory_store` returned all of the above in cleartext on
   stdout. Five secret categories were exposed to the conversation buffer
   before being scrubbed.
2. The default state dir on the author's machine sits inside a
   OneDrive-synced path. Plaintext secrets at rest in a cloud-synced
   directory is a meaningful exfiltration risk independent of any
   application-level bug.

The repo invariant of **no required cloud calls** and the
[CLAUDE.md](../../CLAUDE.md) rule "all persistent state goes through
`lib/db` or `lib/stores`" both apply: any encryption mechanism must work
entirely offline and must be hosted in `lib/`, not via a side-process or
network-dependent secret service.

## Decision

Encrypt the value column of secret-bearing rows at rest using
**AES-256-GCM** with a per-machine **master key** stored in the host
operating system's keychain.

### Master key

- 32 bytes of `crypto.randomBytes` generated on first run.
- Stored via [`keytar`](https://www.npmjs.com/package/keytar) under
  service `"jarela"`, account `"master-key.v1"`.
  - Windows: Credential Manager (DPAPI).
  - macOS: login Keychain.
  - Linux: libsecret / Secret Service.
- Loaded once at process start into module memory; subsequent
  encrypt/decrypt calls remain synchronous.
- **Fallback**: if keychain access fails (no desktop session on Linux,
  Mac keychain locked, `keytar` native binary missing), write the key
  to `${JARELA_DB_DIR}/.secret-key` with `0600` permissions and log a
  one-line warning at startup. The UI surfaces a persistent warning
  banner (similar to the existing notification-permissions banner) so
  the degradation is visible. Refusing to start is rejected as too
  hostile for headless / first-run / installer scenarios.
- Keytar choice over `@napi-rs/keyring`: keytar is the more widely-
  vetted option with the longer prebuilt-binaries track record, despite
  its repo being archived in 2023. The API surface we use (`getPassword`
  / `setPassword`) is trivial and unlikely to need future maintenance.

### Envelope

- Algorithm: AES-256-GCM, 12-byte random IV per value, 16-byte auth tag.
- Wire format on disk: `enc:v1:<base64url(iv ‖ ciphertext ‖ tag)>`.
- The `enc:v1:` prefix:
  - Marks the value as encrypted vs. legacy plaintext.
  - Reserves a version number for a future rotation or algorithm change
    without a destructive migration.
- All encryption / decryption goes through a single module
  `lib/crypto/envelope.ts`. No store implements its own crypto.

### Granularity

Encrypt the **entire JSON value** of secret-bearing rows, not individual
fields. Rationale:

- The four tables involved never query their JSON content; the encrypted
  blob is opaque to SQLite anyway.
- Per-field encryption would require maintaining a schema of "which
  fields are secret" inside the storage layer, duplicating the
  `INTEGRATIONS[name].fields[].secret` declarations and creating drift
  risk when a new field is added.
- The cost is that non-secret fields inside the same JSON (e.g. the
  `url` and `email` on the Atlassian integration) are encrypted too.
  That's deliberate: it means even adversaries who read the DB file
  can't enumerate which integrations are configured.

### Migration

- **Lazy on read**: `decryptIfNeeded()` returns the plaintext for both
  formats, so partially-migrated DBs continue to work mid-rollout.
- **Eager on startup**: a one-time migration walks the four
  tables/namespaces, re-writes any value without the `enc:v1:` prefix
  through `encrypt()`, and updates `updated_at`. The migration is
  idempotent — a second run is a no-op.
- The legacy-data-dir migration (`~/.langgui` → `~/.jarela`) runs first;
  the encryption migration runs against the resolved current dir.

### Scope of v1

In scope:

1. `memory_store` rows where `namespace ∈ {"integrations",
   "github-copilot-auth"}`.
2. `model_configs.params`.
3. `mcp_servers.spec.env`.

**Out of scope (deferred):**

- Baileys session files at `${JARELA_DB_DIR}/baileys/`. Encrypting these
  cleanly requires wrapping Baileys' file I/O or switching to
  `useSingleFileAuthState` with an encrypted wrapper. Re-pair on key loss
  is the accepted recovery story for v1. Documented as a known gap.
- Per-thread / per-user key derivation (single user, single device).
- Hardware key (TPM / Secure Enclave / YubiKey). Out of scope for a
  personal-use project; keytar already offers OS-level protection.
- Key rotation. The `enc:v1:` prefix reserves room for a future
  `enc:v2:` migration if/when needed.

## Consequences

**Positive**

- DB file alone is no longer enough to exfiltrate secrets: an attacker
  must also extract the master key from the user's OS keychain (or, in
  the fallback path, read the keyfile from the same directory — same
  threat model as today, but at least uniform).
- Keychain pinning to the logged-in OS user means a `~/.jarela` copy
  exfiltrated to another machine cannot be decrypted, even by the same
  Windows account name.
- All existing call sites continue to work synchronously: the master key
  is loaded once at boot.
- Version prefix gives a clean migration path for algorithm changes.

**Negative**

- New native dep (`keytar`) adds prebuilt binaries to the install
  footprint. Mitigated by `keytar` shipping prebuilt N-API binaries for
  all of Jarela's supported platforms (win-x64, mac-x64, mac-arm64,
  linux-x64).
- **macOS prompt papercut**: keychain reads are pinned to the calling
  binary's code signature. Upgrading Node or rebuilding native modules
  surfaces a "node wants to access keychain" prompt; first-time install
  always prompts. Workaround documented in README.
- **Windows DPAPI account binding**: the master key is decryptable only
  by the Windows user that wrote it. If Jarela is ever relaunched under
  a different account (e.g. switching the scheduled task from "current
  user" to `SYSTEM`), decryption fails. The current
  `scripts/install-to-system.ps1` registers the task under the current
  user, so this is not an issue today, but it constrains future install
  changes.
- **Keyfile fallback is no stronger than today**: if keychain is
  unavailable and we fall back to `${JARELA_DB_DIR}/.secret-key`, an
  attacker who can read the DB can also read the key. The fallback's
  only real value is preserving the encrypted-at-rest invariant for
  threat models where the DB and the keyfile end up in different places
  (e.g. cloud sync misconfiguration). The UI warning makes the
  degradation visible.
- **Baileys remains unprotected** for v1. WhatsApp impersonation via a
  copied `~/.jarela/baileys/<bridge_id>/` directory is still possible.
  Re-pair on loss; do not put `~/.jarela` in a cloud-synced location
  (addressed separately in ADR-0006).
