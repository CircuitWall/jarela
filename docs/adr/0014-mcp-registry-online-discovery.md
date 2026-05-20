---
status: accepted
date: 2026-05-20
deciders: andwu
consulted:
informed:
---

# Online MCP server discovery via the official MCP Registry

## Context and Problem Statement

Jarela's MCP server picker shipped a hand-curated list of 14 entries in `lib/mcp/registry.ts`. Seven of those entries pointed at upstream `@modelcontextprotocol/server-*` packages that Anthropic deprecated and moved to [`servers-archived`](https://github.com/modelcontextprotocol/servers-archived) in May 2025 (`github`, `puppeteer`, `brave-search`, `slack`, `sentry`, `postgres`, `google-maps`). Maintaining a curated mirror of every vendor migration is unsustainable, and the list cuts users off from the wider ecosystem (~thousands of servers vs. 14).

The official [MCP Registry](https://registry.modelcontextprotocol.io/) launched as a stable, read-only REST API maintained by Anthropic + GitHub + Microsoft + PulseMCP. It is the canonical discovery source for MCP clients and exposes a frozen v0.1 schema.

How should Jarela surface MCP servers to users?

## Decision Drivers

* Eliminate the maintenance burden of tracking upstream package deprecations by hand.
* Give users access to the full catalog rather than a 14-server slice.
* Keep the existing UI flow (picker → variable form → install) intact for users.
* Honour [CLAUDE.md](../../CLAUDE.md) project invariants: no telemetry, no required cloud calls beyond what the user explicitly engages with.

## Considered Options

* **Online-only** — drop the static list and have the picker query `registry.modelcontextprotocol.io` on demand.
* **Hybrid** — keep the curated list as the default view, add an online search input below.
* **Curated-only** — fix the seven deprecated entries by hand and continue maintaining the static list.

## Decision Outcome

Chosen option: **Online-only**. The registry is reliable, the API is frozen, and the maintenance cost of a curated mirror outweighs the upside (instant load) for a flow the user only enters when adding a new server. The trade-off — picker requires network — is acceptable because it's user-initiated, not a boot-time dependency.

### Consequences

* **Good** — Users discover the full ecosystem (vendor-official GitHub MCP, Microsoft's Playwright MCP, Brave's Brave Search MCP, Sentry's hosted MCP, etc.). Deprecations propagate automatically when upstream updates.
* **Good** — Curated list is replaced with a single network call + Zod-validated translation, reducing code in `lib/mcp/registry.ts` substantially.
* **Bad** — Picker is unusable offline. Mitigated by clear error UI with retry and a 15-minute in-memory cache that keeps recent searches working briefly without network.
* **Bad** — Agent-proposed installs (`install_mcp` action) now require the upstream's fully-qualified name (e.g. `io.github.brave/brave-search-mcp-server`) instead of our short slug. The agent's tool description must reflect this.
* **Neutral** — `${HOME}` substitution, `applyVariables`, and `RegistryEntry` types stay so downstream UI/store code is unchanged.

## Pros and Cons of the Options

### Online-only

* Good — no maintenance.
* Good — broadest coverage.
* Bad — network required to add a server.

### Hybrid

* Good — instant first-paint with curated entries; full discovery via search.
* Bad — UI complexity (two list sections, dedupe logic) for marginal value once the upstream registry is reliable.
* Bad — curated list still drifts.

### Curated-only

* Good — fully offline.
* Bad — perpetual maintenance burden every time a vendor renames a package.
* Bad — 14-server ceiling.

## More Information

* Implementation: `lib/mcp/upstream-registry.ts` (schema, fetch, cache, translation), `app/api/v1/mcp-servers/registry/route.ts` (proxy), `components/mcp/MCPPanel.tsx` (search UI).
* Upstream API docs: https://registry.modelcontextprotocol.io/docs
* Server.json schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
* Related: ADR-0010 (agent-led setup) — `install_mcp` action's `registry_id` semantics changed here.
