---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Wrap registered tools so the agent loop also flows through dispatch + timeout

## Context and Problem Statement

ADR-0044 introduced the per-tool wall-clock timeout (`withToolTimeout`); ADR-0047 introduced the central dispatch chokepoint (`runToolDispatched`) for structured logging + result normalisation. Both were applied inside `executeTool` in `lib/tools/index.ts`.

That covers the proposals path, the watcher tool, the direct-API surface, and a handful of smaller call sites. It does **not** cover the chat hot path. LangGraph's `createReactAgent` invokes each tool via its `StructuredTool#invoke(args, config)` directly through LangChain's machinery — `executeTool` is never called on this path. So the chat tool calls that 99% of users actually generate had:

- **No deadline.** A hung MCP server kept the turn alive until the run-registry's 15-min wall-clock watchdog (PR-#122/#123) fired.
- **No structured log.** Debugging "what did this turn do" still required scraping `console.error` lines across modules.

ADR-0047 flagged this as a follow-up. With the long-task directive front and centre, deferring it leaves PR-1's headline fix essentially undelivered — the protections existed, just not where the user spends their time.

## Decision Drivers

* **Coverage parity.** Whatever path invokes a tool — agent loop, executeTool, future async caller — should get the same observability + deadline.
* **No tool-author churn.** Adding `withToolTimeout` / `runToolDispatched` calls to every tool's source would be invasive and easy to miss on new tools.
* **Idempotent.** A tool re-fetched (external hot-reload, MCP cache refresh) shouldn't get double-wrapped and double-log.
* **Backward compatible at the wire.** LangGraph's react agent expects tool invocations to return strings (or values stringifiable into a `ToolMessage`). The wrap must not break that.

## Considered Options

* **(A) Wrap at the source — every `registerTools` / `loadExternalTools` / `getMcpTools` call.** Coverage everywhere; one place to maintain the wrap.
* **(B) Wrap inside `getAllToolsAsync` only.** Misses callers that skip `getAllToolsAsync` (e.g. `executeTool` looks up `ALL_BUILTINS` directly).
* **(C) Document the gap; ask tool authors to call dispatch from inside their tool.** Won't happen consistently; same problem ADR-0047 was trying to avoid.
* **(D) Move the LangGraph agent away from prebuilt's react agent so we can interpose at the loop level.** Big architectural change; not justified.

## Decision Outcome

Chosen: **(A) Wrap at the source.**

The new private helper `wrapToolWithDispatch(t)` in `lib/tools/index.ts` mutates `t.invoke` to flow through `runToolDispatched(() => withToolTimeout(...))`, preserving every other property (name, description, schema) so LangGraph's serialization is unaffected. A `WRAPPED_MARK` symbol on the tool guards against double-wrap when external/MCP tools are re-fetched.

The wrap is applied:
- Once to `ALL_BUILTINS` at module load (`registeredTools()` snapshot).
- Per-load to `loadExternal().tools` — external tools cache-bust per call.
- Per-fetch to `await getMcpTools()` — MCP set is invalidated on `mcp_servers` config change.

After the wrap, `executeTool` simplifies to a thin lookup-then-invoke layer; its own explicit `dispatch + timeout` composition is no longer needed (and would double-log if kept). `executeToolStructured` similarly simplifies — it just normalises the wrap's legacy-shape output back to `ToolResult` for typed callers.

### Consequences

* Good — the chat hot path now has the same observability + deadlines as every other path. PR-1's tool timeout actually fires on real user turns.
* Good — adding a new built-in / external / MCP tool requires no special call to enable dispatch; coverage is automatic.
* Good — debugging long-task tool issues now produces a structured `[tool-dispatch]` log entry per call.
* Good — backward compatible at the LangGraph boundary: the wrap returns the same legacy raw shape (`toLegacyShape`) that the prior `tool()`-built tools returned, so `ToolMessage` content is unchanged.
* Bad — `t.invoke` is mutated rather than wrapped via Proxy. This is fine for our use (we own the tools) but couples to LangChain's class-instance shape; a major LangChain version bump might require revisiting.
* Bad — `WRAPPED_MARK` is a Symbol stored on the tool object. Future LangChain versions that freeze tool instances would break this; we'd need Proxy fallback. Acceptable risk today.

## Pros and Cons of the Options

### (A) Wrap at the source (chosen)

* Good — single chokepoint owns the wrap; tool authors don't touch it.
* Good — coverage is mechanical: every entry point feeds the wrap.
* Good — idempotent guard means re-fetched tools are safe.
* Neutral — mutates `t.invoke` in place. Pragmatic; ties us to LangChain's class shape.

### (B) Wrap inside `getAllToolsAsync` only

* Good — minimal change.
* Bad — `executeTool` and any future code path that uses `ALL_BUILTINS` directly bypasses it. Same coverage hole as today.

### (C) Tool-author opt-in

* Good — most flexible; tool author can choose granularity.
* Bad — won't be consistent. New tools ship without dispatch; bug reports get blamed on "the tool" not "the missing wrap".

### (D) Replace prebuilt react agent

* Good — full control over the loop.
* Bad — large engineering cost. Also rolls our own agent loop, which has been fine in `createReactAgent` form.

## Implementation notes

* `wrapToolWithDispatch(t)`: mutates `t.invoke` with a closure that calls `runToolDispatched(() => withToolTimeout((signal) => originalInvoke(args, {...config, signal}), ...))` and returns `toLegacyShape(result)`. The `signal` is read from `config.signal` if upstream supplied one (LangGraph plumbs the agent stream's abort signal through here).
* `WRAPPED_MARK = Symbol.for("@jarela/dispatch-wrapped")` — persistent across module reloads via `Symbol.for`, so a hot-reloaded external tool is recognised as already wrapped if its module-level instance survived.
* `executeTool` simplifies to `t.invoke(args, config)` — the wrap covers it. `executeToolStructured` calls `toToolResult(raw)` to convert back to the typed union for callers that prefer it over the legacy shape.
* `ALL_BUILTINS` is wrapped once at module load via `wrapAll(registeredTools())`. `loadExternal()` and `getAllToolsAsync()` apply the wrap inline on each fetch (idempotent, safe).
* Cross-references: ADR-0044 (StreamChunk schema, the boundary contract this wrap rides on), ADR-0047 (central dispatch — this ADR closes the agent-loop coverage hole flagged there). Stacked on PR-1 and PR-4 — open in that order.
