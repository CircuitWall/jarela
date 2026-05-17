# 6. Move default Windows state directory off OneDrive-synced paths

Date: 2026-05-17

## Status

Accepted

## Context

ADR-0003 commits Jarela to a single local SQLite state directory at
`${JARELA_DB_DIR}`. The default fallback resolution in
[lib/db/data-dir.ts](../../lib/db/data-dir.ts) is `join(homedir(),
".jarela")`, which on Windows expands to `C:\Users\<user>\.jarela`.

On machines where the user has enabled OneDrive's "Known Folder Move"
(KFM) for the Windows user profile — common on consumer Windows installs
and effectively the default for many work accounts — `~` resolves to a
OneDrive-synced path such as `C:\Users\<user>\OneDrive\…`. The result is
that `~/.jarela` ends up inside a folder that OneDrive uploads to the
cloud.

For Jarela's contents, that's wrong on two fronts:

1. **Secret material.** Even after ADR-0005 encrypts secrets at rest in
   SQLite, the `${JARELA_DB_DIR}/baileys/<bridge_id>/` directory remains
   plaintext (out of scope for v1 encryption). A WhatsApp session synced
   to the cloud is a session anyone with the cloud account can replay.
2. **DB file integrity.** SQLite's WAL mode writes `*.db-wal` and
   `*.db-shm` sidecar files. OneDrive treats those as user files,
   periodically reads them, occasionally locks them, and on rare
   occasions creates conflicted-copy duplicates. Either behaviour is
   capable of corrupting the DB or stalling startup.

The author's own machine exhibits the OneDrive case, which is what
surfaced this ADR.

## Decision

Change the **Windows-only** default state directory from
`join(homedir(), ".jarela")` to
`join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
"Jarela")`. On macOS and Linux the default remains `~/.jarela`.

- `JARELA_DB_DIR` continues to override the default unconditionally and
  is the only documented production knob; explicit override skips all
  default-resolution logic and all auto-migration.
- `%LOCALAPPDATA%` is excluded from OneDrive KFM by Microsoft's own
  product design: it is the canonical local-only directory on Windows.
- On first run, if the **legacy** `~/.jarela` directory exists and the
  target `%LOCALAPPDATA%\Jarela` does not yet contain a Jarela DB file,
  perform a one-time **content-merge** migration:
  1. Create the target dir if missing.
  2. For each entry in the legacy dir, `renameSync` it into the target,
     skipping any entries that already exist on the destination side
     (this handles the case where the installed launcher has already
     populated the target with `logs/` and `files/`).
  3. Cross-volume cases (`EXDEV`) and locked-file cases
     (`EPERM`/`EBUSY`) log a warning and continue with the rest of the
     items.
  4. Rmdir the legacy dir if it ends up empty.
- The presence-check is "does the target contain `jarela.db` or
  `langgui.db`" rather than "does the target exist". The user's
  installed-launcher run may have created a `%LOCALAPPDATA%\Jarela\logs`
  for stdout/stderr long before the data dir migrated; that should not
  block migration of the real state.
- The migration is idempotent: on subsequent runs the legacy path is
  gone, so the migration is a no-op.

The macOS and Linux defaults are deliberately **not** changed. The
equivalent target on macOS would be `~/Library/Application Support/Jarela`,
which is correct but disruptive for users who have already configured
`~/.jarela`. The OneDrive-sync risk is Windows-specific in practice. If
a comparable risk appears on macOS (e.g. iCloud Drive's optional
desktop-folder sync), revisit in a follow-up ADR.

## Consequences

**Positive**

- New Windows installs land in `%LOCALAPPDATA%\Jarela`, which is excluded
  from OneDrive sync by design.
- Existing Windows installs are migrated on the first run after upgrade,
  with the same safety properties as the existing rebrand migration
  (atomic same-volume rename, refuse-and-log on conflict).
- SQLite WAL files no longer race with a cloud-sync agent on default
  installs.

**Negative**

- Power users who explicitly chose `~/.jarela` (without setting
  `JARELA_DB_DIR`) are silently moved to `%LOCALAPPDATA%`. Documented
  in the README and surfaced via a one-line `console.info` at migration
  time. Setting `JARELA_DB_DIR=$HOME/.jarela` explicitly opts back in.
- The Windows scheduled-task installer (`scripts/install-to-system.ps1`)
  references the working directory implicitly via the launcher script;
  no change to the installer is required because the launcher reads the
  data dir from the same code path.
- Backups, sync rules, and any third-party tools that knew about
  `~/.jarela` on Windows must be updated. The README change for ADR-0005
  and ADR-0006 will document the new path.

## Alternatives considered

1. **Leave the default at `~/.jarela`** and rely on a README note.
   Rejected: the OneDrive case is silent, the data corruption mode is
   real, and "did you read the README" is not a security posture.
2. **Detect OneDrive and warn at startup**. Rejected: it pushes the
   user to choose between renaming their profile setup or moving the
   data dir manually, when the right answer is just to put the data
   somewhere OneDrive doesn't touch by default.
3. **Move to `%APPDATA%`** (the roaming variant). Rejected:
   `%APPDATA%` is also frequently included in roaming profile / cloud
   sync setups in enterprise environments. `%LOCALAPPDATA%` is the
   canonical "this stays on this machine" location.
