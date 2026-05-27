---
status: accepted
date: 2026-05-20
deciders: example-user
consulted:
informed:
---

# Sync standard credential env vars from shell rc / Windows User registry

## Context and Problem Statement

When Jarela runs from an interactive `npm run dev` shell, every credential the user has exported in `~/.zshrc` / `~/.bashrc` is already in `process.env`, and the existing env-then-store fallback in [lib/tools/atlassian.ts](../../lib/tools/atlassian.ts) and [lib/tools/github.ts](../../lib/tools/github.ts) just works. But the production install path on macOS uses a `LaunchAgent` ([scripts/install-to-system.sh](../../scripts/install-to-system.sh)) and on Linux a systemd user unit — neither of which sources interactive shell rc files. The same user, same machine, same `.zshrc`, but the installed app doesn't see `GITHUB_TOKEN`. Users have to retype each token in the Integrations panel, then retype it again every time they rotate.

Windows is the inverse: User-scope env vars set in *Settings → Edit environment variables* (registry-backed) are inherited by every process the user spawns, so the installed app already sees them. But values set only inside a PowerShell `$PROFILE` (`$env:FOO = …`) are session-local and *not* inherited.

Should the app paper over this gap, and if so, where does the source of truth live?

## Decision Drivers

* The installed-vs-dev divergence is the most common credential support question — invariably "but my token is in `.zshrc`, why doesn't it work?" The fix should require zero user action beyond install.
* Credentials rotate. If the user updates `.zshrc`, the change should propagate without retyping.
* Some users *want* to type the token in the Connections tab and have that be authoritative. Sourcing rc on every request would silently overwrite their choice.
* Cross-platform — macOS LaunchAgent, Linux systemd-user, Windows. Each has a different "user-scope env" mechanism.
* CLAUDE.md invariants: no new daemon, no telemetry, single Next.js process, no required cloud calls. Whatever we add must run inside the existing process.

## Considered Options

* **Source rc files on every process boot** — `launcher.sh` runs `source ~/.zshrc`, exports everything, exec's the app. Simplest, but inherits all the rc cost (slow shell init, version-manager shims, prompt setup) and makes runtime behavior depend on user dotfiles.
* **One-shot copy at install time** — `install-to-system.sh` greps allowlisted vars from rc, writes them to `~/.jarela/proxy.env`. Plaintext on disk, no rotation pickup, but cheap.
* **Encrypted DB cache populated by a cross-platform discovery probe** *(this ADR)* — sync allowlisted vars into the encrypted integration store via a child-process probe (zsh/bash `-ic` on Unix, `[Environment]::GetEnvironmentVariable($n, 'User')` on Windows). Track per-field provenance so panel edits are not overwritten.

## Decision Outcome

Chosen option: **encrypted DB cache, populated by a cross-platform probe with per-field provenance**.

### Conflict rule — "panel-wins-once-touched"

Each integration field gets a `source` flag in [lib/stores/integration_meta.ts](../../lib/stores/integration_meta.ts):

* `"rc"` — last write came from the env-syncer. Future syncs may overwrite.
* `"user"` — user typed the value into the Connections tab. The syncer never touches this field again.

`saveIntegration()` flips changed fields to `"user"`. The syncer only writes fields whose flag is `"rc"` or absent. This makes rotation flow through transparently while never silently undoing a manual edit.

### Trigger points

* **Boot, once per process** — [lib/db/index.ts](../../lib/db/index.ts) calls `runEnvSyncOnce()` after DB init, fire-and-forget. New installs auto-populate; rotation picks up on restart.
* **Manual** — *Sync from environment* button in the built-in integrations section of the Connections tab ([components/integrations/IntegrationsPanel.tsx](../../components/integrations/IntegrationsPanel.tsx)) calls `POST /api/v1/env-sync`. Returns a `SyncResult` so the UI can explain *why* nothing changed (e.g. "field skipped because you edited it here").

### Cross-platform probe

* **macOS / Linux** — spawn `$SHELL -ic '<print-allowlisted>'`. The `-i` flag is what causes rc sourcing. Output is framed with a unique sentinel so version-manager init logs / oh-my-zsh banners can't poison the parser. 4 s hard timeout.
* **Windows** — spawn `pwsh.exe` (preferred) or `powershell.exe` (always present), call `[Environment]::GetEnvironmentVariable($n, 'User')` per allowlisted var. `[Console]::OutputEncoding = UTF8` is forced because Windows PowerShell 5.1 emits UTF-16 LE by default.

### Allowlist

Hard-coded in [lib/env/allowlist.ts](../../lib/env/allowlist.ts) — only known credential vars get pulled, never user PATH/PS1/etc. Today: `GITHUB_TOKEN`/`GH_TOKEN`, `ATLASSIAN_URL`/`JIRA_URL`, `ATLASSIAN_EMAIL`/`JIRA_EMAIL`, `ATLASSIAN_API_TOKEN`/`JIRA_API_TOKEN`/`JIRA_TOKEN`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`. Each maps to a specific integration + field, so adding a new var is one line and an unrelated allowlist drift breaks the manifest lint.

### Consequences

* **Good** — installed launchers work out of the box for every user who already has tokens in their dotfiles. Rotation flows through automatically on restart (or one click).
* **Good** — manual edits in the UI are preserved — the conflict rule is explicit and auditable in the per-field `source` flag, surfaced as a "from shell" badge in the UI.
* **Good** — cross-platform: macOS LaunchAgent, Linux systemd-user, Windows registry, dev-shell — the same code path covers all four.
* **Good** — values stay in the existing encrypted `integrations` namespace (ADR-0005). The metadata namespace is plaintext but contains only `{source, rc_synced_at}` flags.
* **Bad** — adds a child-process spawn at boot. Bounded by the 4 s timeout and runs once per process; failures are warnings, never fatal.
* **Bad** — sync only fires on app restart or explicit button click. We do not watch rc files for changes — for the user who rotates and reloads, this is fine; for an always-on app where they expect the very next tool call to pick up the new value, an explicit click is required. The trade-off is ruled out for now: filesystem watchers across three OSes for what is rarely a 30-second-mattering change.
* **Bad** — values that exist *only* in PowerShell `$PROFILE` (not in the registry) are not picked up on Windows. Users must use the *Settings → Environment Variables* dialog (which writes to the registry) for those vars. Documented in the panel tooltip.

## Pros and Cons of the Options

### Source rc on every boot via launcher.sh

* Good — zero DB schema, every var available, not just allowlisted ones.
* Bad — pulls in the user's full rc (oh-my-zsh, nvm/pyenv shims, prompt) on every cold start; can take seconds.
* Bad — non-deterministic. Editing rc changes app behavior with no rebuild signal.
* Bad — leaks unrelated env (HISTFILE, prompts, completions) into the server process.
* Bad — Windows has no rc-equivalent; needs a parallel codepath anyway.

### One-shot copy at install time

* Good — dead simple, no runtime cost.
* Bad — no rotation pickup. User rotates `.zshrc`, must rerun the installer.
* Bad — values land in plaintext `~/.jarela/proxy.env`, side-stepping the encrypted store.
* Bad — fresh installs only; existing users stuck retyping.

### Encrypted DB cache + cross-platform probe (chosen)

* Good — bounded scope (allowlist), bounded latency (4 s timeout), bounded surface (no fs watchers, no extra processes).
* Good — values land in the same encrypted store the panel writes to. Tools resolve them via the existing env-then-store fallback unchanged.
* Good — rotation works on restart or one click. Conflict rule means panel edits are never silently undone.
* Bad — child-process spawn adds startup cost (typical ~70 ms on macOS, untested on cold Windows boot).
* Bad — third source of truth (rc, panel, encrypted DB) — provenance flag mitigates by making it explicit, but it's still more state.

## More Information

* [ADR-0005 — at-rest encryption envelope](0005-at-rest-encryption.md) — credentials live in the encrypted `integrations` namespace.
* [ADR-0009 — in-app HTTP proxy](0009-in-app-http-proxy-configuration.md) and [ADR-0012 — proxy CA bundle](0012-proxy-ca-bundle.md) — env-then-DB precedence pattern this ADR follows.
* [ADR-0010 — agent-led setup](0010-agent-led-setup-and-integration-manifests.md) — defines the Connections-tab UX that env-sync feeds into.
* [ADR-0015 — native GitHub tools](0015-native-github-tools.md) — the immediate beneficiary, since `GITHUB_TOKEN` is overwhelmingly an rc resident.
* Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are intentionally out of scope: they live in `ModelConfig.params` per-model, not in the integrations store, so a 1:1 env→field mapping doesn't fit. A follow-up ADR will define a "provider defaults" namespace that env-sync can target.
