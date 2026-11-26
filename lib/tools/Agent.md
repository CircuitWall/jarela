---
description: "Use when: implementing, fixing, or testing tools in lib/tools/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Tools Module Agent

Scope: `lib/tools/` — built-in tool definitions, registration metadata,
categories and capabilities, dependency declarations, package bundles, and MCP
catalog integration.

Follow [AGENTS.md](../../AGENTS.md) and the [MCP guide](../mcp/Agent.md).
Public consumers import from [index.ts](./index.ts) and
[runtime/types.ts](./runtime/types.ts); keep that facade stable.

## Boundary

- `lib/tools/` owns built-in definitions and their category/capability/
  integration/dependency metadata. The runtime catalog applies agent
  permissions; tools never authorize themselves.
- Registration happens at module load. Adding a built-in touches the tool file
  and one side-effect import in [runtime/builtins.ts](./runtime/builtins.ts).
  There is no central tool map.
- MCP tools are discovered in `lib/mcp/` and merged into the catalog with
  `source: "mcp"`; they are not re-registered here.
- The public surface is `Capability`, `ToolCategory`, `ToolGroup`,
  `BuiltinCategory`, and `registerTools` from [runtime/registry.ts](./runtime/registry.ts);
  everything else there is internal runtime API.

## Tool contract and description quality

The tool name, description, schema, and output are the model-facing interface;
treat them as product surface.

- **Name:** snake_case `verb_object`, globally unique. A rename is a catalog
  breaking change: update permissions, allowlists, tests, and docs together.
- **Description:** state what it does, when to use it, when *not* to use it,
  input semantics, output shape, side effects, and refusal behavior. Explicit
  negative constraints are part of the contract — see
  [authoring-operations.ts](./general/authoring-operations.ts) for the
  "pending is not success" and "does not approve" style. Do not write a
  one-line description for a tool with side effects.
- **Schema:** `z.strictObject` with bounded strings, arrays, and numbers; reject
  unknown fields; never accept an untyped record or a parameter that grants
  authority the tool does not own (publication, approval, installation).
- **Output:** return a JSON string (or `AsyncGenerator<string>` when streaming)
  with stable named fields. Refusals return the documented structured shape;
  they are not silent success. Never return `undefined`, bare prose, or a
  success shape for failed work.
- **Capability:** register the narrowest true class — `read` has no side
  effects, `write` mutates persisted or user-visible state, `execute` runs
  external commands or effects. Mixed bundles register per capability bucket.
- **Scope:** no module-level mutable state. Read thread/agent identity from the
  LangGraph `config`; write idempotently or read back after the write.
- **Secrets:** resolve credentials inside the owning integration/auth helper.
  Never put a secret in the description, output, or error message.

## Standard patterns

### 1. Define and register a built-in

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getMemory } from "@/lib/stores/memory";
import { registerLangChainPackage } from "../packages/langchain-package";

const schema = z.strictObject({ namespace: z.string(), key: z.string() });

export const memoryReadTool = tool(
  async ({ namespace, key }) => getMemory(namespace, key)?.value ?? "null",
  {
    name: "memory_read",
    description: "Read one memory value. Does not create or modify memory.",
    schema,
  },
);

registerLangChainPackage({ category: "Memory", tools: { read: [memoryReadTool] } });
```

Then append `import "../general/memory";` (or the new module) to
[runtime/builtins.ts](./runtime/builtins.ts). Duplicate names throw at
registration; that is a bug, not a warning. `registerTools(category,
capability, tools, integration?, dependencies?)` is the lower-level entry point
used by the package loader.

### 2. Stream output

Return an `AsyncGenerator<string>` and register under the correct capability.
The registry wraps every built-in with the wall-clock guard in
[support/wallclock.ts](./support/wallclock.ts); do not add a second timeout
wrapper or a manual abort loop.

### 3. Register package bundles

Use [langchain-package.ts](./packages/langchain-package.ts) with read, write,
and execute buckets. It also wires the optional auth bridge (environment first,
then the encrypted integration store, then a not-configured error) and
dependency declarations. Declare binaries/packages with `DependencySpec` so the
catalog marks the tool unavailable instead of failing mid-call (ADR-0121).

### 4. Consume MCP tools

`getMcpTools()` and `getMcpToolMeta()` in [lib/mcp/client.ts](../mcp/client.ts)
are the only loading surface. Never construct an `MCPAdapter` in a tool module,
and call `invalidateMcpTools()` from every server CRUD or proposal mutation.
MCP tools are uniformly `execute`; do not add a tool-local permission path.

### 5. Let the catalog apply policy

Permissions, capability filtering, hot-load selection, and the tool bind budget
are applied in [runtime/catalog.ts](./runtime/catalog.ts). A tool receives only
the calls that survived those filters; it must not re-read agent configuration
or grant itself access.

## Anti-patterns

- **Loose input schema** — a permissive object or `any` lets the model send
  malformed arguments. Use `z.strictObject` with bounds.
- **Orphan tool** — a tool without its side-effect import in
  [runtime/builtins.ts](./runtime/builtins.ts) is unreachable. Do not invent a
  central `TOOLS_CATALOG`; registration is the registry call plus that import.
- **Success-shaped refusal** — returning `{ ok: true }`, an empty string, or
  prose when work failed hides the failure from the agent and the UI.
- **Streaming type mismatch** — a function declared as an async generator must
  actually `yield`; an `async` function returning one value is a contract bug.
- **Global mutable state** — concurrent calls interfere. Use parameters and
  request-scoped state.
- **Authority parameters or self-approval** — tools must not accept
  publication/approval/installation grants they do not own, and must not treat
  an acknowledgement as proof of downstream completion.
- **Re-registering MCP tools** — they are discovered at runtime; registering
  them as built-ins duplicates the catalog and bypasses MCP policy.
- **Secrets in descriptions or output** — they end up in prompts, logs, and
  transcripts.
- **Per-tool timeout wrappers** — the wall-clock guard already bounds every
  built-in call.

## File map

| Concern | Files |
| --- | --- |
| Public facade | [index.ts](./index.ts), [runtime/types.ts](./runtime/types.ts), [core/index.ts](./core/index.ts) |
| Registry and catalog | [runtime/registry.ts](./runtime/registry.ts), [runtime/catalog.ts](./runtime/catalog.ts), [runtime/runtime.ts](./runtime/runtime.ts), [runtime/categories.ts](./runtime/categories.ts) |
| Built-in barrel | [runtime/builtins.ts](./runtime/builtins.ts) |
| Domain tools | [general/](./general/), [filesystem/](./filesystem/), [web/](./web/), [communications/](./communications/), [delegation/](./delegation/), [security/](./security/), [system/](./system/) |
| Packages | [packages/langchain-package.ts](./packages/langchain-package.ts), [packages/langchain-packages.ts](./packages/langchain-packages.ts), [packages/default-packages.ts](./packages/default-packages.ts) |
| Support | [support/wallclock.ts](./support/wallclock.ts) |

Tests are co-located with each tool module (for example
[general/authoring.test.ts](./general/authoring.test.ts)) and with the runtime
(for example [runtime/registry.test.ts](./runtime/registry.test.ts),
[runtime/capability-coverage.test.ts](./runtime/capability-coverage.test.ts),
[runtime/dependency-gating.test.ts](./runtime/dependency-gating.test.ts)).

## Testing requirements

- Registration: assert `registeredCapability()` and `registeredCategory()` for
  every new tool; use `_resetRegistry()` when a test registers fixtures.
- Schema: `convertToOpenAITool()` must show `additionalProperties: false`, and
  unknown or authority-granting parameters must be rejected.
- Behavior: cover the happy path, the documented refusal shape, error handling,
  and read-back for writes.
- Streaming: assert multiple ordered chunks and cleanup on early consumer exit.
- Isolation: use temporary directories and mocked network/MCP boundaries; never
  spawn a real MCP server in a unit test.
- Run the focused Vitest files, `npx tsc --noEmit`, and `npm run lint`.

## Review checks

- [ ] Tool name is unique, snake_case, and unchanged unless a rename was
      coordinated.
- [ ] `z.strictObject` schema with bounds and no authority parameters.
- [ ] Description states when to use and when not to use the tool.
- [ ] Output is a documented string/stream shape; refusals are explicit.
- [ ] Capability and category are the narrowest true values.
- [ ] Tool module is imported from `runtime/builtins.ts`.
- [ ] MCP tools are consumed, not re-registered.
- [ ] Registration, schema, behavior, and streaming tests pass.
- [ ] `npx tsc --noEmit` and `npm run lint` pass.
