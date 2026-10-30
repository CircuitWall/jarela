---
description: "Use when: implementing, fixing, or testing tools in lib/tools/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Tools Module Agent

**Specialization:** Building and testing tool implementations for the LangGraph agent runtime.

**Scope:** `lib/tools/` directory and related `lib/tools/runtime/` files. Individual tool functions and the registry system.

---

## 🎯 Domain Context

### What Tools Are

Tools are the **executable capabilities** that LangGraph agents use:
- Input: Zod-validated, typed request
- Output: Typed result (string, JSON, or AsyncGenerator for streaming)
- Purpose: Bridge agent decisions to actions (file ops, web requests, calculations, etc.)

### Key Principles

1. **Type Safety First**
   - Every tool has Zod input schema + TypeScript types
   - Output type must be explicit (not `any`)
   - Compile-time safety prevents runtime failures

2. **Registration Mandatory**
   - Tools must register in `lib/tools/runtime/registry.ts`
   - Registry is the single source of truth
   - Unregistered tools are unreachable

3. **Streaming Optional**
   - Simple tools return `Promise<OutputT>`
   - Streaming tools return `AsyncGenerator<string>`
   - Agents can render streaming output progressively

4. **Error Boundaries Required**
   - All tools must handle errors gracefully
   - Errors should be structured and informative
   - Timeouts, permissions, and missing resources expected

5. **Pure or Request-Scoped**
   - Tools should not modify global state
   - Side effects must be documented
   - Multiple concurrent executions must not interfere

---

## 📋 Coding Patterns

### Pattern 1: Basic Synchronous Tool

```typescript
import { Tool } from "@/lib/tools/types";
import { z } from "zod";

// 1. Define input schema with Zod
const SearchFilesInput = z.object({
  pattern: z.string().describe("Glob pattern (e.g., **/*.tsx)"),
  maxResults: z.number().int().positive().optional().describe("Max results to return"),
});

export type SearchFilesInputType = z.infer<typeof SearchFilesInput>;

// 2. Implement tool with strict typing
export const searchFilesTool: Tool<SearchFilesInputType, string> = {
  name: "search_files",
  description: "Search for files matching a glob pattern in the repository",
  inputSchema: SearchFilesInput,
  
  execute: async (input: SearchFilesInputType): Promise<string> => {
    try {
      // Implementation
      const files = await findFiles(input.pattern, input.maxResults);
      return files.join("\n");
    } catch (error) {
      // Return structured error message
      if (error instanceof Error && error.message.includes("Permission denied")) {
        return `Error: Permission denied. Cannot search in protected directory.`;
      }
      return `Error: Failed to search files: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
```

**Checklist:**
- ✅ Input schema defined with Zod
- ✅ Type exported for reuse
- ✅ Tool name is snake_case
- ✅ Description is user-facing and clear
- ✅ Error handling with try/catch
- ✅ Error messages are human-readable

---

### Pattern 2: Streaming Tool

```typescript
export const streamFilesTool: Tool<ReadFileInputType, AsyncGenerator<string>> = {
  name: "read_file_stream",
  description: "Read a file and stream output in chunks",
  inputSchema: ReadFileInput,
  
  // Use async generator function
  execute: async function* (input: ReadFileInputType): AsyncGenerator<string> {
    try {
      const content = await fs.readFile(input.path, "utf-8");
      const chunkSize = 1024;
      
      // Yield content in chunks
      for (let i = 0; i < content.length; i += chunkSize) {
        yield content.substring(i, i + chunkSize);
      }
    } catch (error) {
      yield `Error: Failed to read file: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
```

**Checklist:**
- ✅ Function is declared as `async function*`
- ✅ Return type is `AsyncGenerator<string>`
- ✅ Yields chunks progressively (not all at once)
- ✅ Error handling included within generator

---

### Pattern 3: Tool with MCP Integration

```typescript
import { MCPClient } from "@/lib/mcp/client";

const MCPToolInput = z.object({
  server: z.string().describe("MCP server name"),
  resource: z.string().describe("Resource identifier"),
});

export type MCPToolInputType = z.infer<typeof MCPToolInput>;

export const mcpTool: Tool<MCPToolInputType, string> = {
  name: "call_mcp_resource",
  description: "Call a resource through MCP server",
  inputSchema: MCPToolInput,
  
  execute: async (input: MCPToolInputType): Promise<string> => {
    const mcp = new MCPClient();
    
    try {
      // MCP operations might fail if server is unavailable
      const result = await mcp.readResource(input.server, input.resource);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
        return `Error: MCP server "${input.server}" is not available`;
      }
      return `Error: Failed to call MCP: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
```

**Checklist:**
- ✅ MCP client used, not embedded
- ✅ Server availability errors handled
- ✅ Connection errors identified
- ✅ Output is JSON or structured text

---

## 🚫 Anti-Patterns (AVOID THESE)

### ❌ Anti-Pattern 1: Untyped Input

```typescript
// WRONG - No Zod schema, input type is implicit
export const badTool: Tool = {
  name: "bad_tool",
  execute: async (input) => {
    // What shape is input? Unclear!
    return input.something;  // Might crash
  },
};
```

**Why?** At runtime, agent might pass wrong input shape → crash.

**Fix:** Always define Zod schema first, then derive TypeScript type.

---

### ❌ Anti-Pattern 2: Tool Not Registered

```typescript
// Tool defined but...
export const orphanTool: Tool = { /* ... */ };

// ❌ Not in registry.ts - Agent can't find it!
```

**Why?** Tool exists but agent can't discover it. Wasted code.

**Fix:** Add to `lib/tools/runtime/registry.ts`:
```typescript
export const TOOLS_CATALOG = {
  // ... other tools
  orphan_tool: orphanTool,  // ✅ Now discoverable
};
```

---

### ❌ Anti-Pattern 3: No Error Handling

```typescript
export const dangerousTool: Tool<InputT, string> = {
  name: "dangerous",
  execute: async (input) => {
    // No try/catch - if this throws, agent crashes
    return JSON.stringify(await externalAPI(input));
  },
};
```

**Why?** External APIs fail, files don't exist, permissions denied → unhandled errors crash everything.

**Fix:** Wrap in try/catch, return error message as string:
```typescript
execute: async (input) => {
  try {
    return JSON.stringify(await externalAPI(input));
  } catch (error) {
    return `Error: API call failed: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
},
```

---

### ❌ Anti-Pattern 4: Type Mismatch in Streaming

```typescript
// ❌ WRONG - Says AsyncGenerator but returns Promise
export const badStreaming: Tool<InputT, AsyncGenerator<string>> = {
  execute: async (input) => {  // This is async function, not async generator!
    return "result";
  },
};
```

**Why?** Agent expects streaming but gets single value → type error, won't work.

**Fix:** Use `async function*` and `yield`:
```typescript
export const goodStreaming: Tool<InputT, AsyncGenerator<string>> = {
  execute: async function* (input) {
    yield "chunk1";
    yield "chunk2";
  },
};
```

---

### ❌ Anti-Pattern 5: Tool Modifies Global State

```typescript
let callCount = 0;  // ❌ Global state

export const statefulTool: Tool = {
  execute: async (input) => {
    callCount++;  // ❌ Concurrent calls interfere!
    return `Call #${callCount}`;
  },
};
```

**Why?** Multiple agents calling simultaneously → race conditions → unpredictable results.

**Fix:** Use only parameters and local state:
```typescript
export const statelessTool: Tool<InputT, string> = {
  execute: async (input) => {
    // All state comes from input
    // Local variables are safe
    const count = input.count + 1;
    return `Call #${count}`;
  },
};
```

---

## 📁 File Structure

```
lib/tools/
├── types.ts                  ← Tool interface: type Tool<I, O>
├── registry.ts               ← Tool registry + catalog
├── runtime/
│   ├── types.ts              ← Runtime types for public API
│   ├── registry.ts           ← Runtime registry (re-exported)
│   └── index.ts              ← Public exports (lib/tools/runtime/*)
│
├── files.ts                  ← File operations (read, write, move, delete)
├── web.ts                    ← Web operations (fetch, search, render)
├── wallclock.ts              ← Timing wrapper for tool execution
├── [db-operations].ts        ← Database queries (if needed)
├── [custom-tools].ts         ← Domain-specific tools
│
└── __tests__/
    ├── files.test.ts         ← Tests for files.ts
    ├── web.test.ts           ← Tests for web.ts
    └── [tool].test.ts        ← Tests for each tool
```

**Rule:** Each `*.ts` tool file should be ~50-100 lines. Larger tools should be split into multiple files or extracted into services.

---

## ✅ Testing Requirements

### Requirement 1: Input Validation Test

Every tool must validate that bad input is rejected:

```typescript
describe("searchFilesTool", () => {
  it("rejects invalid pattern", () => {
    expect(() => {
      SearchFilesInput.parse({ pattern: null });
    }).toThrow();
  });

  it("accepts valid pattern", () => {
    expect(() => {
      SearchFilesInput.parse({ pattern: "**/*.ts" });
    }).not.toThrow();
  });
});
```

### Requirement 2: Happy Path Test

Normal usage should work correctly:

```typescript
it("finds matching files", async () => {
  const result = await searchFilesTool.execute({
    pattern: "**/*.test.ts",
    maxResults: 10,
  });
  
  expect(result).toContain(".test.ts");
  expect(result.split("\n").length).toBeLessThanOrEqual(10);
});
```

### Requirement 3: Error Handling Test

Edge cases should be handled gracefully:

```typescript
it("handles missing directory gracefully", async () => {
  const result = await searchFilesTool.execute({
    pattern: "/nonexistent/path/**",
  });
  
  expect(result).toContain("Error");
  expect(result).not.toThrow(); // Returns error message, not thrown
});
```

### Requirement 4: Streaming Test (If Applicable)

Streaming tools must yield progressively:

```typescript
it("streams file content in chunks", async () => {
  const chunks: string[] = [];
  
  for await (const chunk of streamFilesTool.execute({ path: "large-file.txt" })) {
    chunks.push(chunk);
  }
  
  expect(chunks.length).toBeGreaterThan(1);  // Multiple chunks
  expect(chunks.join("")).toMatch(/expected content/);
});
```

---

## ⚠️ Common Mistakes in This Module

### Mistake 1: Using `JSON.parse()` Without Try/Catch

```typescript
// ❌ BAD - Throws if JSON is invalid
const data = JSON.parse(input.json);

// ✅ GOOD - Handle parse errors
const data = (() => {
  try {
    return JSON.parse(input.json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
})();
```

### Mistake 2: Returning `any` Type

```typescript
// ❌ BAD - Type is too loose
execute: async (input): Promise<any> => {
  // Anything could be returned
  return { whatever: true };
};

// ✅ GOOD - Explicit return type
execute: async (input): Promise<string> => {
  return JSON.stringify({ status: "success" });
};
```

### Mistake 3: Forgetting Input Validation in Description

```typescript
// ❌ BAD - Agent doesn't know constraints
const SearchInput = z.object({
  query: z.string(),
  limit: z.number(),  // No validation range!
});

// ✅ GOOD - Clear constraints
const SearchInput = z.object({
  query: z.string().min(1).max(500).describe("Search query"),
  limit: z.number().int().min(1).max(100).describe("Max results (1-100)"),
});
```

### Mistake 4: Not Exporting Tool Type

```typescript
// ❌ BAD - Type is internal
const SearchInput = z.object({ /* ... */ });
export const searchTool: Tool<typeof SearchInput, string> = { /* ... */ };

// ✅ GOOD - Type exported for reuse
export const SearchInput = z.object({ /* ... */ });
export type SearchInputType = z.infer<typeof SearchInput>;
export const searchTool: Tool<SearchInputType, string> = { /* ... */ };
```

### Mistake 5: Console.log() in Production

```typescript
// ❌ BAD - Logs to console, hard to debug
execute: async (input) => {
  console.log("Input:", input);
  const result = await process(input);
  console.log("Result:", result);
  return result;
};

// ✅ GOOD - Use structured logging or return info in output
execute: async (input) => {
  // Debug info can be included in output if needed
  const result = await process(input);
  return result;
};
```

---

## 📋 Alignment Checklist

Before opening a PR with tool changes, verify:

### Code Quality
- [ ] Zod schema defined for input (not inferred types)
- [ ] Tool type exported: `Tool<InputT, OutputT>`
- [ ] Output type is explicit (never `any` or `unknown`)
- [ ] Implements `Tool` interface correctly

### Error Handling
- [ ] All async operations wrapped in try/catch
- [ ] Errors returned as strings (never thrown)
- [ ] Error messages are user-friendly (not stack traces)
- [ ] Timeout/rate-limit errors handled
- [ ] Permission errors identified clearly

### Testing
- [ ] Input validation tests pass
- [ ] Happy path test covers normal usage
- [ ] Error case test covers edge cases
- [ ] Streaming test passes (if applicable)
- [ ] Test coverage >80%

### Registration & Exports
- [ ] Tool exported from `lib/tools/runtime/registry.ts`
- [ ] Tool name is unique and snake_case
- [ ] Tool added to `TOOLS_CATALOG` object
- [ ] Input type exported for reuse

### Documentation
- [ ] JSDoc comments on tool and execute function
- [ ] Zod field descriptions are clear
- [ ] README updated if tool is user-facing
- [ ] Examples provided in comments

### No Regressions
- [ ] Existing tests still pass
- [ ] No new global state
- [ ] No console.log() statements
- [ ] No circular imports

---

## 🔗 Related

- **Technical Debt:** See [TECHNICAL_DEBT_QUICK_WINS.md](../TECHNICAL_DEBT_QUICK_WINS.md) for tool extraction patterns
- **Modular Agent Strategy:** See [MODULAR_AGENT_STRATEGY.md](../MODULAR_AGENT_STRATEGY.md) for module-level agent guidance
- **Tool Types:** See `lib/tools/types.ts` for interface definitions
- **Tool Registry:** See `lib/tools/runtime/registry.ts` for registration patterns

---

**Questions?** See MODULAR_AGENT_STRATEGY.md or CONTRIBUTING.md for more context.
