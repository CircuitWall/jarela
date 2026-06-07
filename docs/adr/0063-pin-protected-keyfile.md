# 63. PIN-protected keyfile fallback

Date: 2026-06-07

## Status

Proposed

## Context

ADR-0005 ships at-rest encryption with a 32-byte AES-256-GCM master key
held by the host OS keychain. When the keychain is unavailable
(headless Linux, locked macOS keychain, missing `@napi-rs/keyring`
native binary, Windows Credential Manager corruption) the
implementation falls back to a `0600`-permissioned `${JARELA_DB_DIR}/.secret-key`
file. The file is *not* itself encrypted — its only protection is the
POSIX mode bit (or the equivalent ACL on Windows).

That fallback is enough against the original threat (a cloud sync agent
naively uploading `~/.jarela` to OneDrive — the file mode keeps it out
of the sync set on Windows, and the keyfile alone is useless without
the SQLite DB next to it). It is **not** enough against:

- An attacker who exfiltrates the entire data dir (DB + keyfile) and
  can then decrypt every credential offline at their leisure.
- A backup taken in flight (Time Machine, File History, Restic) that
  captures both files into a single archive.
- A user account on a shared machine where the same Windows profile is
  used by multiple humans.

Users on the keyfile fallback today see a banner saying "protect the
data directory accordingly", which is good as a warning but offers them
no mitigation. They want to add a second factor — something they know,
not just something the keyfile sits next to.

The keychain path remains the recommended default. This ADR is about
hardening the *fallback* without disrupting the keychain users.

## Decision

When the user opts in via the Security panel, the keyfile is rewritten
to a **PIN-wrapped form** at `${JARELA_DB_DIR}/.secret-key.enc`. The PIN
is a fixed-length 6-digit numeric code. The on-disk format wraps the
existing 32-byte master key with a Key Encryption Key (KEK) derived from
the PIN via the **`scrypt`** KDF built into `node:crypto` (no new
dependency, memory-hard, OWASP-endorsed alongside argon2id).

### Wrapping format

`secret-key.enc.v1` is a single file with the following layout
(big-endian where multi-byte numbers appear):

```
offset  bytes  field
0       1      version           // 0x01
1       1      kdf               // 0x01 = scrypt
2       4      kdf_log2_n        // scrypt cost (N = 2 ** kdf_log2_n)
6       4      kdf_r             // scrypt block size
10      4      kdf_p             // scrypt parallelism
14      16     kdf_salt
30      12     aes_nonce         // GCM nonce
42      32     wrapped_key       // AES-256-GCM(master_key, KEK)
74      16     auth_tag
90      <end>
```

- **scrypt parameters (v1):** `N = 2^17` (131,072), `r = 8`, `p = 1`,
  derived-key length `32`. These are the [OWASP Password Storage Cheat
  Sheet recommendation for scrypt](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)
  and target ~128 MiB working memory + ~500 ms on a 2024-class laptop.
  The `kdf_*` fields are stored alongside the wrapped key so the
  parameters can be tuned upward in v2 without a hard migration — the
  unlock code reads them out and feeds them straight to
  `crypto.scrypt`.
- **Why scrypt over argon2id:** both are memory-hard KDFs in the OWASP
  top tier; scrypt is shipped with Node 25 (`node:crypto.scrypt`), so
  picking it avoids adding a new native dependency to a codebase that
  already keeps native deps deliberately minimal (see ADR-0034 on
  dropping `better-sqlite3`). For a 6-digit PIN the difference in
  attacker-cost between the two at OWASP-recommended parameters is
  noise compared to the rate-limit + offline-only-after-data-dir-theft
  threat model. A future ADR can swap to argon2id if a user-supplied
  passphrase variant ever lands and needs the memory-hardness floor.
- **6-digit PIN justification:** 10^6 = 1 M combinations. With scrypt
  at N=2^17 (~128 MiB working memory, ~500 ms per attempt on a fast
  laptop, much slower on commodity attacker hardware that bottlenecks
  on memory bandwidth), the full keyspace takes thousands of CPU-hours
  per attacker GPU instance. The rate-limit on the unlock endpoint
  makes online attack infeasible; the KDF cost makes offline attack
  expensive enough that the user can rotate the PIN before it falls.
  4-digit PINs were rejected: 10^4 combinations with no online
  protection would fall in under a day on a determined attacker's
  hardware. Variable-length PINs / passphrases were deferred to v2.

### Process state model

A new `MasterKeyState` enum: `unlocked | locked | uninitialized`.

- **uninitialized**: no key material anywhere. First run; the bootstrap
  generates a fresh key and stores it via the keychain path (or
  plaintext keyfile fallback, same as ADR-0005). No PIN.
- **unlocked**: `_key` is populated in module memory. All encrypted
  store calls work normally. Identical to today.
- **locked**: `${JARELA_DB_DIR}/.secret-key.enc` exists; no `_key` in
  memory yet. Set on every boot for users with a PIN configured. Stays
  locked until a successful `unlockMasterKey(pin)` call.

`getMasterKey()` throws a typed `MasterKeyLockedError` while locked.
Existing call sites — `encrypt()`, `decryptIfNeeded()`,
`runCryptoMigration()`, every encrypted-store accessor — propagate the
error unchanged. The HTTP layer maps it to **HTTP 423 Locked** with a
small JSON body the splash screen consumes.

### Boot sequence change

`getDb()` no longer eagerly initializes the master key. It splits into
two phases:

1. Open the SQLite handle and run migrations. Migrations are DDL only;
   they do not need the key.
2. Try `initMasterKey()`. If the wrapped keyfile exists and no PIN has
   been supplied yet, leave the state as `locked` and skip the lazy
   crypto sweep (it would need to encrypt). The sweep runs on the
   first successful unlock instead.

Background jobs that need encrypted state (scheduler, watchers, bridge
listeners) check `getMasterKeyState()` before pulling secrets and either
log a single "locked, deferred" notice or no-op. They resume on unlock
via a `master-key:unlocked` event on the existing notifications bus.

### Unlock HTTP endpoint

`POST /api/v1/security/unlock` with `{ "pin": "123456" }`:

- Rejects when not in `locked` state (returns 409 with current state).
- Strict per-IP rate limit: 3 attempts, then exponential backoff
  starting at 30 s and capping at 5 min. Counters live in memory; a
  process restart resets them (also re-prompts the user, so no
  amplification).
- Constant-time PIN verification — derivation always runs to
  completion regardless of whether the wrapped-key auth tag will
  verify, so timing leaks nothing about which prefix of the PIN was
  correct.
- PIN never enters the log sink. The route body is added to the
  redaction allowlist in `lib/logging/sink.ts`.
- On success: derives KEK, unwraps the master key, populates `_key`,
  flips state to `unlocked`, runs the deferred crypto sweep, emits
  `master-key:unlocked` on the notification bus.

Companion routes:

- `GET /api/v1/security/state` → `{ state: "unlocked" | "locked" | "uninitialized", pin_enabled: boolean }`. Always reachable.
- `POST /api/v1/security/pin` (requires unlocked) → enable / change /
  disable PIN. Disable requires the current PIN; enable accepts the
  new PIN and rewrites `.secret-key` → `.secret-key.enc`.

### Splash-screen unlock UI

The existing `<Splash visible={!agentsLoaded}>` component is extended
with a second mode: when `GET /api/v1/security/state` returns
`{ state: "locked" }`, the splash renders a 6-digit number pad plus an
empty progress strip of 6 dots. Each pad press fills the next dot. The
6th press auto-submits. Physical keyboard digits work identically;
Backspace clears the last dot; Enter is a no-op (auto-submit handles
it). On 423 the dots flash red and the user is told how many attempts
remain before the backoff kicks in. The pad is the only thing on the
splash until unlock succeeds; the rest of the app does not mount.

### Settings UI

A new `SecurityPanel` (linked from the Profile menu) exposes:

- **Status row**: "Master key in keychain" / "Master key in keyfile" /
  "Master key in PIN-wrapped keyfile".
- **Enable PIN**: prompts for a 6-digit code twice (entry + confirm),
  argon2id-derives the KEK, wraps the in-memory master key, writes
  `.secret-key.enc` with mode `0600`, deletes the old `.secret-key`,
  and surfaces a one-line success notice.
- **Change PIN**: requires the current PIN, then the new one twice.
- **Disable PIN**: requires the current PIN, then unwraps and writes
  back the plaintext `.secret-key` (only available in keyfile-fallback
  mode; keychain users never see this row).

## Considered Options

1. **PIN-wrapped keyfile via scrypt** *(chosen)* — survives offline
   attack at the chosen parameters; opt-in so headless deployments
   keep working; no new dependency (scrypt is in `node:crypto`).
2. **Use the platform's biometric API (TouchID / Hello / Polkit)** —
   too much per-platform surface and incompatible with the
   "ssh-into-the-box and start the daemon" headless story. Could
   layer on top of the PIN path later as a convenience.
3. **TPM / Secure Enclave-sealed key** — strongest, but requires native
   modules per OS and rules out Linux desktops without a TPM. Out of
   scope.
4. **Refuse to start without a PIN** — hostile to first-run and
   headless. Rejected for the same reasons ADR-0005 rejected refusing
   to start without a keychain.

## Decision Outcome

Chosen: **option 1**, opt-in PIN-wrapped keyfile.

### Consequences

- Good, because users on the keyfile fallback get a credible second
  factor against backup-snapshot and stolen-data-dir threats.
- Good, because the change is opt-in and zero-config for keychain
  users (the dominant path) and for headless deployments that prefer
  the current behavior.
- Good, because the wrapped-keyfile format is versioned and the KDF
  parameters are inline, leaving room for scrypt tuning (or swap to
  argon2id in a future ADR) without a destructive migration.
- Bad, because PIN-enabled deployments lose the "starts automatically
  on boot" property — scheduled tasks, watchers, and bridge listeners
  pause until the next unlock. This is the explicit tradeoff; the
  Settings panel makes the implication clear at enable time.
- Bad, because losing the PIN with a wrapped keyfile means losing the
  data. The Settings panel and the splash both surface a warning
  before the PIN is set; recovery requires re-installing and
  reconfiguring every credential, which is the same blast radius as
  losing `.secret-key` today.
- Neutral, because the KDF cost adds ~500 ms to every cold start when
  unlocked. Acceptable for a once-per-boot interactive prompt.

## More Information

- ADR-0005 (encrypt secrets at rest) — defines the master key, the
  envelope format, and the keychain path. This ADR strictly extends
  the *fallback* branch of that ADR and changes nothing about the
  keychain path.
- ADR-0006 (Windows state dir) — locates the keyfile on Windows.
- OWASP Password Storage Cheat Sheet (scrypt and argon2id
  recommendations).
- [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) —
  the keytar-compatible NAPI binding currently used for keychain
  access; unrelated to PIN wrapping but worth noting alongside since
  this ADR is sometimes confused with a replacement for the keychain.
