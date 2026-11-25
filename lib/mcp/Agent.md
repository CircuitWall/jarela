---
description: "Use when: implementing, fixing, or testing MCP discovery and invocation in lib/mcp/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# MCP module guidance

Follow [AGENTS.md](../../AGENTS.md). MCP tools have their own loading and policy
boundary; they are not built-in tools and must not be forced through the
built-in registration lifecycle.

## Boundary

`lib/mcp/` owns the in-process MCP connection manager, transport configuration,
tool-result normalization, and upstream registry discovery. It does not own
agent permissions, tool categorization policy, or persistence.

- Built-in tools register explicit category and capability metadata through
  `lib/tools/runtime/registry.ts`. MCP tools are discovered from enabled MCP
  server rows and merged into the catalog with `source: "mcp"` at runtime
  (`lib/tools/runtime/runtime.ts`).
- MCP tools are uniformly `execute` capability. Read-only turns filter them out
  and `executeTool` refuses non-read entries; do not add a separate permission
  path in this module.
- Server rows, encrypted specs, and last-error state belong to
  `lib/stores/mcp-servers.ts`. Mutations must invalidate the MCP tool cache.
- `lib/mcp/registry.ts` is a public package export; keep its data contract and
  `${VAR}` substitution stable ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Standard patterns

### 1. One connection manager, cached by configuration

`getMcpTools()` in [client.ts](./client.ts) is the only tool-loading surface.
It builds one adapter per enabled server, caches the resulting tools, dedupes
in-flight loads, and discards results from a superseded generation.
`invalidateMcpTools()` closes clients and bumps the generation; every CRUD or
proposal mutation must call it.

- Cache key: stable hash of enabled server name, transport, and spec.
- Empty configuration short-circuits without connecting.
- Do not instantiate `MCPAdapter` anywhere else.

### 2. Select transport from the stored spec

[client.ts](./client.ts) maps `stdio` to `{ command, args, env }` through
`buildSubprocessEnv` and everything else to streamable HTTP
`{ url, headers }`. Legacy SSE is rejected during upstream import. Adapter
options disable elicitation, auto mode, and server-name prefixes so tool names
remain stable.

### 3. Isolate failures per server

One broken server must not poison the others. Each enabled server gets its own
adapter; connection failures are recorded with `setMcpServerError` and the load
continues with the remaining servers. Close aggregation uses
`Promise.allSettled`.

### 4. Normalize results at the adapter boundary

[tool-results.ts](./tool-results.ts) installs the `afterToolCall` hook that
appends `structuredContent` as a text block while preserving text, multimodal
content, and artifacts. Keep `_meta` private. This is the only place that
reshapes MCP results; wallclock result spilling happens later in the runtime.

### 5. Build the child environment explicitly

`buildSubprocessEnv` layers host environment, cached shell environment, the
credential store, and per-server `spec.env`, then scrubs Jarela control
variables and package tokens. Environment-name validation and merge live in
[environment.ts](./environment.ts); the API accepts an untyped record, so
validation at the boundary remains a review point.

### 6. Bound upstream registry work

[upstream-registry.ts](./upstream-registry.ts) fetches the official registry
with `AbortSignal.timeout`, validates the response with Zod, clamps the result
limit, caches with a TTL, and distinguishes archived/non-latest entries.
Discovery failures degrade to an empty/fresh result, never an unbounded retry.
See [ADR-0014](../../docs/adr/0014-mcp-registry-online-discovery.md).

## Anti-patterns

- **Spawning a server per tool call** — use the singleton cache; rebuild only
  through invalidation.
- **Leaking child processes** — ensure a client is closed when `listTools()`
  fails and when a load completes after invalidation. These are known hardening
  gaps in [client.ts](./client.ts); do not copy the current shape into new code.
- **Serializing unbounded structured content** — downstream result spilling
  bounds storage, but the hook itself has no cap. Add a bound before treating
  large artifacts as text.
- **Trusting server-supplied capability or integration metadata** — category,
  group, and integration annotations may inform display; capability stays the
  runtime's `execute` policy.
- **Hand-rolling variable substitution** — reuse `applyVariables` in
  [registry.ts](./registry.ts); the MCP panel currently duplicates it and must
  not be copied.
- **Swallowing transport errors as "not found"** — `getUpstreamByName` conflates
  outage and absence; callers must not present the result as authoritative.
- **Assuming tool names are globally unique** — server-name prefixes are
  disabled, so two servers exposing the same name collide in the catalog.

## Files

| File | Responsibility |
| --- | --- |
| [client.ts](./client.ts) | Connection manager, cache, invalidation, environment |
| [environment.ts](./environment.ts) | Stdio environment validation and merge |
| [registry.ts](./registry.ts) | Public registry contract and variable substitution |
| [tool-results.ts](./tool-results.ts) | `afterToolCall` structured-content bridge |
| [upstream-registry.ts](./upstream-registry.ts) | Official registry discovery/import |

Consumers: `lib/tools/runtime/runtime.ts` and
`lib/tools/runtime/catalog.ts` (merge and policy), `lib/agents/proposals.ts`
(install/toggle), `app/api/v1/mcp-servers/route.ts` and the `[name]` route
(CRUD + invalidation), `components/mcp/MCPPanel.tsx` (editor), and
`lib/tools/system/mcp-servers-info.ts` (introspection).

## Testing requirements

- Unit tests are co-located: [client.test.ts](./client.test.ts),
  [environment.test.ts](./environment.test.ts),
  [tool-results.test.ts](./tool-results.test.ts),
  [upstream-registry.test.ts](./upstream-registry.test.ts).
- Mock `@langchain/mcp-adapters` with a fake adapter; never spawn a real server
  in unit tests. Use `vi.resetModules()` to reset the module singleton.
- Use `vi.stubGlobal("fetch")` for registry tests and assert URL, timeout
  wiring, filtering, caching, and malformed payload rejection.
- [tool-results.test.ts](./tool-results.test.ts) is the one real transport
  test: it starts a loopback `node:http` fixture and always closes the adapter
  and server. Follow that cleanup shape for new transport tests.
- Cover invalidation, stale in-flight results, per-server failure isolation,
  and result-hook shapes when touching [client.ts](./client.ts).
- Run focused Vitest files, `npx tsc --noEmit`, and `npm run lint`.

## Pre-PR checklist

- [ ] No new adapter construction outside [client.ts](./client.ts).
- [ ] Every mutation path invalidates the tool cache.
- [ ] Failure isolation and cleanup cover success, failure, and invalidation.
- [ ] External input is validated and bounded; secrets stay out of logs.
- [ ] Capability remains `execute`; no permission bypass.

## Frontier

- **Structured-content bridge** ([tool-results.ts](./tool-results.ts)) — recent
  adapter hook with a real HTTP regression fixture; documented in
  [EXTENDING.md](../../docs/EXTENDING.md).
- **Generation-based stale-result discard** ([client.ts](./client.ts)) — newer
  than the cache itself; needs race tests before it is standard.
- **Fresh timeout read per registry call** ([upstream-registry.ts](./upstream-registry.ts))
  — supports runtime override; one implementation.
