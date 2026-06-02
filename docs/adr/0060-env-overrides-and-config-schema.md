---
status: accepted
date: 2026-06-02
deciders: example-user, claude
---

# Centralized JARELA_* schema, persistent overrides, runtime restart, agent control

## Context and Problem Statement

Operational knobs accumulated across the codebase — timeouts, ring-buffer caps, retry budgets, log filters — and the way they were exposed was inconsistent:

- A handful (`JARELA_PORT`, `JARELA_TOOL_TIMEOUT_MS`, `JARELA_LLM_STREAM_MAX_MS`, …) read from env at module init.
- The majority were hard-coded constants in their owning file (`MAX_BUFFERED = 4000`, `FETCH_TIMEOUT_MS = 15_000`, `MAX_OUTPUT_BYTES = 8_000`, …).
- Users running the desktop app couldn't change anything without finding the install dir, hand-editing a launchd plist / systemd unit / Task Scheduler XML, and restarting.
- There was no single place to discover what knobs exist, what their defaults are, or which ones require a restart.
- Agents couldn't change runtime behavior even when the user asked them to ("agent, raise the LLM stream timeout for this turn").

The audit (transcript) listed 22 wall-clock timeouts and ~30 limits/retries/feature flags worth exposing. We needed a single PR that gave users a UI to edit them, persisted overrides across restarts, and let trusted agents make changes too.

## Decision Drivers

* **Single source of truth.** Adding a new knob should be a one-line schema change, not an N-file scatter.
* **No second process.** Persistence is a JSON file under `JARELA_DB_DIR` (the existing data directory contract); no daemon, no DB migration.
* **Hybrid hot-reload.** Most knobs should take effect without a restart; only bind-time vars (port, hostname, ring-buffer sizes captured at module init) should require one — and the UI should make that obvious.
* **Bounded agent power.** The `set_env_var` tool is gated per-knob via an `agentWritable` flag in the schema. Agents can change a curated list (log level, retry budgets, idle timeout) and explicitly NOT others (port, dataDir, sandbox tier).
* **Explicit-env-wins.** If the user launched the server with `JARELA_PORT=4500 npm start`, the override file shouldn't override that — the explicit flag is a stronger signal than the persisted file.

## Decision Outcome

Chosen architecture:

### 1. Schema (`lib/env/schema.ts`)

A single readonly array of `EnvVarDef` objects:

```typescript
{
  name: "JARELA_RUN_IDLE_MS",
  type: "int",
  default: 90_000,
  description: "Idle watchdog: force-finish a run if no chunk has broadcasted for this long.",
  category: "agent",
  tier: "B",
  requiresRestart: false,
  agentWritable: true,
  min: 1_000,
}
```

The schema is the registry every other piece reads from:
- `lib/env/config.ts` — typed `getConfig()` snapshot, parses int/bool/enum from `process.env` against schema defaults
- `lib/env/overrides.ts` — read/write `~/.jarela/env-overrides.json`, validates against the schema before persisting
- `app/api/v1/env/route.ts` — REST surface returns each entry with current value + override flag + tier
- `lib/tools/system_config.ts` — `set_env_var` agent tool checks the per-var `agentWritable` flag
- `components/env/EnvVarsPanel.tsx` — renders the list grouped by category, with a "show advanced" toggle for tier B/C

### 2. Persistent overrides (`lib/env/overrides.ts`)

`{JARELA_DB_DIR}/env-overrides.json` shape:

```json
{
  "version": 1,
  "entries": {
    "JARELA_RUN_IDLE_MS": "30000",
    "JARELA_LOG_LEVEL": "debug"
  }
}
```

`applyOverridesToProcessEnv()` is called as the FIRST step in `bootNode()`, before any module imports config. Entries already present in the launching env (non-empty `process.env[KEY]`) are skipped — explicit-env-wins. Entries for unknown keys are silently dropped (schema renames don't break boot).

### 3. Hybrid hot-reload

Most knobs are read fresh per use:
```typescript
function maxStallRetries(): number { return getConfig().maxStallRetries; }
```
`getConfig()` is memoised; the PATCH endpoint calls `resetConfigCache()` after writing the override + mutating `process.env[KEY]`, so the next `getConfig()` call rebuilds the snapshot.

A few captures the value at module init (run-registry's `MAX_BUFFERED`, shutdown handler's `HARD_TIMEOUT_MS`, log sink's ring cap) — these are flagged `requiresRestart: true` so the UI shows a "restart" badge and the top-of-panel "Restart server" button.

### 4. Restart endpoint

`POST /api/v1/system/restart` schedules `process.exit(0)` 250 ms after responding. The supervisor (launchd / systemd / Task Scheduler / `installed-launcher.ps1`) relaunches the process. When run directly via `npm start`, the user sees the process exit and restarts manually — that's correct UX for a foreground shell.

### 5. Agent tools (`lib/tools/system_config.ts`)

- `set_env_var({name, value, reason?})` — Writes the override, mutates `process.env`, drops the cache. Returns `{requiresRestart, hint}` so the agent knows whether to call `restart_server` next. Refuses with `code: "forbidden"` for non-`agentWritable` keys.
- `restart_server({reason})` — Hits the same `/api/v1/system/restart` endpoint via fetch (so the response flushes back to the agent before the process tears down).

Both registered under category "Config" / capability "execute". Agents that want them must explicitly include them in their toolset; default agents do not.

### Currently `agentWritable` (audited subset, conservative):
- `JARELA_LOG_LEVEL`
- `JARELA_RUN_IDLE_MS`
- `JARELA_MAX_STALL_RETRIES`
- `JARELA_MAX_TRANSIENT_RETRIES`

Everything else is operator-only — including all bind-time vars (port, hostname, dataDir) and security knobs (tool safety tier, SSRF allowlist).

### 6. Client-side runtime config (`api/runtime-config.ts`)

Browser code can't read `process.env`. A new `/api/v1/config` GET endpoint returns the operationally-safe subset (HTTP request timeout, SSE connect timeout, health-check timeout, retry attempts). The browser fetches it once on first read, caches in a module-level singleton, and refreshes when the EnvVarsPanel saves a change.

`api/client.ts` and `components/ui/ServerStatus.tsx` route their timeouts through `runtimeConfig()` instead of hard-coded constants.

### Consequences

* Good — single PR exposes ~25 new knobs + reorganises ~10 existing ones; future knobs are one schema entry plus the call-site change.
* Good — operators get a discoverable UI; no more grepping for `process.env.JARELA_*`.
* Good — agents can adapt runtime behavior (raise log level for debugging, lower idle timeout for quick smoke tests) without giving them keys to the kingdom.
* Good — boot order is explicit: overrides apply first, then console patch, then everything else. No more "module read env before override applied" footguns.
* Good — the existing `JARELA_*` env vars all keep working; nothing in the operator-facing contract changed.
* Bad — module-init reads (run-registry / shutdown / sink) need restart to pick up changes. Acceptable: the schema flag + UI badge make this discoverable.
* Bad — the schema doubles as docs; if it drifts from actual call-site behavior, users see stale values. Mitigated by `lib/env/config.ts` being the SINGLE place every server-side read flows through, and `runtime-config.ts` the SINGLE place client-side reads flow through.
* Bad — agent-writable list will probably grow under user pressure; tightening it later means a behavior change. Start conservative; expand on demand.
* Neutral — overrides file is a flat JSON map (no nested envs / per-environment). Sufficient for a local app.

## Pros and Cons of the Options

### A) Status quo (env vars only, edit + restart by hand)

* Good — no new code, no new failure modes.
* Bad — no UI, no discoverability; impossible for non-developer users; agents can't help.

### B) JARELA_* env vars only, with a UI panel that just shows what's documented

* Good — minimal new infra.
* Bad — UI lies (only shows pre-known docs, not actual knobs); doesn't solve persistence or agent control.

### C) Centralized schema + overrides file + UI + restart + agent tools (chosen)

* Good — solves all three layers (operator UI, programmatic edit, persistence).
* Bad — bigger PR; more moving parts to keep in sync.
* Mitigation — the schema is the synchronization point; the contract is "if it's not in the schema, it doesn't exist" enforced at write time.

## Implementation notes

* The schema's `tier` field gates UI density. Default view shows tier A only; "Show advanced" reveals B + C. Search across all tiers regardless of toggle so power users can jump straight to obscure knobs.
* `requiresRestart` is set conservatively. When in doubt, mark it true; no one is hurt by an extra restart, but a silently-not-applied override is a footgun.
* Agent-writable defaults are intentionally tight. Adding a new flag should require explicit reasoning — list the threat model in the commit message.
* The `/api/v1/config` endpoint is a *subset* of `/api/v1/env`. The latter is the operator surface (full schema + overrides); the former is the public read for browser code that doesn't need (and shouldn't see) the full surface.
* Boot ordering matters: overrides → console patch → shutdown handlers → tools. Re-ordering would either drop early logs or apply overrides too late.

## Cross-references

ADR-0058 (logs panel — the previous stage in the same operator-tooling thread). ADR-0038 (tool safety tier — `JARELA_TOOL_SAFETY` lives in the same schema, requires_restart=true, agentWritable=false).

[lib/env/schema.ts](../../lib/env/schema.ts) is the single source of truth. [lib/env/overrides.ts](../../lib/env/overrides.ts), [lib/env/config.ts](../../lib/env/config.ts), [app/api/v1/env/route.ts](../../app/api/v1/env/route.ts), [lib/tools/system_config.ts](../../lib/tools/system_config.ts), [components/env/EnvVarsPanel.tsx](../../components/env/EnvVarsPanel.tsx) all derive from it.
