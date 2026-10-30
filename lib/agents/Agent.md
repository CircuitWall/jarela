---
description: "Use when: implementing, debugging, or reviewing LangGraph agent orchestration in lib/agents/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# LangGraph Agent Orchestration Agent

**Specialization:** Building, configuring, and debugging LangGraph agent definitions, state machines, and orchestration logic for Jarela's multi-model, multi-tool agent runtime.

**Scope:** `lib/agents/` directory — all agent definitions, thread management, message handling, tool binding, streaming, and checkpointing logic.

---

## 🎯 Domain Context

### What LangGraph Agents Are

LangGraph is a **state machine framework** for building agents:
- **Nodes:** Functions that run (user input, agent step, tool call, etc.)
- **Edges:** Transitions between states (conditional routing, looping)
- **Messages:** LangChain message format (HumanMessage, AIMessage, ToolMessage, SystemMessage)
- **State:** Persistent context (thread, messages, metadata)
- **Tools:** Executable capabilities the agent can call
- **Streaming:** Real-time output as the agent thinks and acts

### Jarela's Agent Architecture

Jarela builds on LangGraph with enterprise features:

1. **Multi-Model Support**
   - Multiple providers (Anthropic, OpenAI, Google, Cohere)
   - Model routing based on capability/cost
   - Fallback and retry strategies
   - Think tokens and reasoning effort management

2. **Tool Binding & Permissions**
   - Tool catalog (200+ built-in + MCP tools)
   - Per-agent permission lists (allow/deny)
   - Hot-load optimization (bind essential tools, lazy-load optional)
   - Credential routing (per-tool secret selection)

3. **State & Checkpointing**
   - SQLite-backed message store
   - Checkpoint savers for resumable runs
   - Thread context boundaries (memory limits)
   - Message pruning and compaction

4. **Streaming & Realtime**
   - Chunked SSE output to clients
   - Heartbeats for idle-timeout prevention
   - Tool progress reporting mid-call
   - Citation tracking and validation

5. **Budget & Governance**
   - Context window budgeting (input + output tokens)
   - Delegation budgets (prevent infinite recursion)
   - Usage strategy (balance reasoning vs. speed)
   - Cost estimation and tracking

### Key Principles

1. **Stateful Execution**
   - Every agent run is a transaction (messages + checkpoint)
   - Resumability: crash and restart, pick up where you left off
   - No side effects without explicit save

2. **Tool Binding is Explicit**
   - Tools passed to model must be validated before binding
   - Permissions checked at configuration time, re-checked at runtime
   - Credentials injected per-tool, never exposed in prompts

3. **Streaming is Progressive**
   - Token-by-token output to UI as model generates
   - Tool calls streamed as chunks (incremental arguments)
   - Errors can arrive mid-stream and must be handled

4. **Errors are Recoverable**
   - Transient errors (rate limits, timeouts) → retry
   - Permanent errors (auth, not found) → fail gracefully
   - Tool failures recorded in ToolMessage, conversation continues

5. **Context is Bounded**
   - Agents can't see full thread history (too many tokens)
   - Automatic message windowing (recent N messages)
   - Warm summaries for older context
   - Compaction when thread gets too large

---

## 📋 Coding Patterns

### Pattern 1: Basic Agent Run (Thread-Level)

Agent runs are managed by the `run-thread.ts` module. Here's the basic flow:

```typescript
// lib/agents/run-thread.ts
import { streamWithConfig } from "@/lib/agents/llm";
import { buildSystemPrompt, buildHistoryWindow } from "@/lib/agents/prepare";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";

// Main entry point: prepare and run a thread
export async function streamThreadRun(
  threadId: string,
  userMessage: string,
  options: StreamOptions,
): AsyncGenerator<StreamChunk> {
  // 1. Load thread and build context
  const thread = await getThread(threadId);
  const systemPrompt = await buildSystemPrompt(thread, options);
  const historyWindow = await buildHistoryWindow(threadId, options);

  // 2. Add new user message
  await addMessage(threadId, {
    role: "user",
    content: userMessage,
  });

  // 3. Stream agent execution
  yield* streamWithConfig({
    system_prompt: systemPrompt,
    messages: historyWindow,
    allowed_tools: options.agent_run_config?.allowed_tools ?? [],
    model_config_name: options.agent_run_config?.model_config_name ?? null,
  });
}
```

**When to use:** Managing agent conversations, adding new user input, resuming from checkpoint.

---

### Pattern 2: Conditional Routing (State Machines)

Use conditional edges to route between agent behaviors:

```typescript
// lib/agents/model-router.ts
import { routeTurnModel } from "@/lib/agents/model-router";
import type { RouteDecisionMetadata } from "@/api/types";

// Route to best model based on task complexity
export async function routeAgentModel(
  threadId: string,
  previousMessages: BaseMessage[],
  currentTask: string,
): Promise<{ model: string; metadata: RouteDecisionMetadata }> {
  // Analyze task
  const isComplex = previousMessages.length > 10 || currentTask.includes("analyze");
  
  return isComplex
    ? { 
        model: "claude-opus-5", 
        metadata: { reason: "complex-task", routing_method: "heuristic" } 
      }
    : { 
        model: "claude-haiku-4.5", 
        metadata: { reason: "simple-task", routing_method: "heuristic" } 
      };
}

// In your agent graph:
// graph.add_conditional_edges(
//   "agent_node",
//   lambda state: "need_complex_model" if state.task_complexity > threshold else "use_cheap_model",
//   { "need_complex_model": expensive_model_node, "use_cheap_model": cheap_model_node }
// )
```

**When to use:** Choosing models by capability, routing error cases to recovery, branching on user intent.

---

### Pattern 3: Tool Binding with Permissions

Load and bind only permitted tools:

```typescript
// lib/agents/run-thread.ts
import { getAllToolsAsync, allowedToolNamesFromPermissionMap } from "@/lib/tools";
import { getAgentToolCredentials } from "@/lib/stores/agent-configs";

export async function bindToolsForAgent(
  agentId: string,
  allowedToolNames: string[],
): Promise<{ tools: any[], bound: string[], lazy: string[] }> {
  // 1. Get all available tools
  const catalog = await getAllToolsAsync();
  
  // 2. Filter by agent's allowed list
  const permitted = allowedToolNamesFromPermissionMap(
    catalog,
    agentId,
    allowedToolNames,
  );

  // 3. Split into hot-loaded (essential) and lazy-loaded (on-demand)
  const hotLoad = permitted.filter(name => isHotLoadTool(catalog.find(t => t.name === name)));
  const lazy = permitted.filter(name => !isHotLoadTool(catalog.find(t => t.name === name)));

  // 4. Inject per-tool credentials
  const credentials = await getAgentToolCredentials(agentId);
  const wrapped = wrapToolsForCredentialRouting(tools, credentials);

  return {
    tools: wrapped.filter(t => hotLoad.includes(t.name)),
    bound: hotLoad,
    lazy: lazy,
  };
}
```

**When to use:** Building agent tool manifests, enforcing security policies, injecting credentials.

---

### Pattern 4: Streaming with Error Recovery

Handle streaming errors and tool failures gracefully:

```typescript
// lib/agents/run-retry.ts
import { transientRetryStream, stallRetryStream } from "@/lib/agents/run-retry";

export async function* streamWithRetry(
  config: AgentRunConfig,
): AsyncGenerator<StreamChunk> {
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      // Try the agent run
      yield* streamWithConfig(config);
      return; // Success
    } catch (error) {
      attempt++;

      // Check if retryable
      if (shouldRetryTransientError(error) && attempt < maxAttempts) {
        const delayMs = rateLimitRetryDelayMs(error) ?? (attempt * 1000);
        
        yield {
          type: "retry",
          attempt,
          delayMs,
          reason: error.message,
        } as StreamChunk;

        await sleep(delayMs);
      } else {
        // Permanent error or max attempts reached
        yield {
          type: "error",
          code: "agent_failed",
          message: error.message,
        } as StreamChunk;
        throw error;
      }
    }
  }
}
```

**When to use:** Streaming agent output, handling rate limits, recovering from transient failures.

---

### Pattern 5: Message Windowing (Context Management)

Keep message history bounded by token count:

```typescript
// lib/agents/prepare.ts
import { buildHistoryWindow } from "@/lib/agents/prepare";
import { estimateTokens } from "@/lib/agents/context-budget";

export function buildHistoryWindow(
  threadId: string,
  config: { 
    history_limit?: number; 
    history_window_hours?: number;
    context_budget_tokens?: number;
  },
): BaseMessage[] {
  const thread = getThread(threadId);
  const allMessages = getMessagesPage(threadId, 0, Infinity);

  // 1. Filter by time window
  const windowSinceMs = config.history_window_hours 
    ? Date.now() - config.history_window_hours * 3600_000
    : 0;
  
  const candidates = allMessages.filter(m => 
    new Date(m.timestamp).getTime() > windowSinceMs
  );

  // 2. Truncate by message count
  const byCount = candidates.slice(-config.history_limit ?? 50);

  // 3. Truncate by token budget
  let accumulated = 0;
  const finalWindow = [];
  
  for (const msg of byCount.reverse()) {
    const tokens = estimateTokens(msg.content);
    if (accumulated + tokens > config.context_budget_tokens ?? 50000) {
      break;
    }
    finalWindow.unshift(msg);
    accumulated += tokens;
  }

  return toBaseMessages(finalWindow);
}
```

**When to use:** Building agent context windows, preventing context overflows, managing memory.

---

## ⚠️ Anti-Patterns (What NOT to Do)

### Anti-Pattern 1: Unregistered Agents or Tools

❌ **Wrong:**
```typescript
// Using an agent or tool that's not in the registry
const result = await runAgent("my-custom-agent"); // No registry entry

// Binding tools without checking registry
const tools = [myTool, anotherTool]; // No validation
```

✅ **Right:**
```typescript
// Check registry before using
const agentDef = await getAgentConfig(agentId);
if (!agentDef) throw new Error(`Agent ${agentId} not registered`);

// Use getAllToolsAsync() to get validated tools
const tools = await getAllToolsAsync();
const permitted = tools.filter(t => allowedNames.includes(t.name));
```

**Why:** Unregistered agents/tools can't be discovered, audited, or authorized.

---

### Anti-Pattern 2: Exposing Credentials in Prompts

❌ **Wrong:**
```typescript
// NEVER put secrets in the system prompt
const systemPrompt = `You are an agent with API key: ${process.env.OPENAI_KEY}`;

// NEVER pass raw credential objects to tools
const result = await tool({
  credential: fullCredentialFromStore, // Exposes all secret fields
  ...userInput,
});
```

✅ **Right:**
```typescript
// Credentials injected per-tool at runtime
const tools = wrapToolsForCredentialRouting(rawTools, credentials);

// System prompt never mentions secrets
const systemPrompt = `You are an agent with access to these tools...`;

// Tools receive only validated, minimal credential info
const wrappedTool = (input) => {
  const cred = credentialStore.get(input.credentialId);
  return innerTool({ ...input, token: cred.accessToken });
};
```

**Why:** Credentials in prompts can leak in logs, model outputs, or caching.

---

### Anti-Pattern 3: Unbounded Message History

❌ **Wrong:**
```typescript
// Passing all messages to every agent run
const allMessages = await getAllThreadMessages(threadId);
const result = await agent.invoke({
  messages: allMessages, // Could be millions of tokens!
});
```

✅ **Right:**
```typescript
// Always use windowing and budgeting
const config = await getAgentConfig(agentId);
const window = buildHistoryWindow(threadId, {
  history_limit: config.history_limit ?? 50,
  history_window_hours: config.history_window_hours ?? 8,
  context_budget_tokens: computeContextBudget(model, config),
});

const result = await agent.invoke({
  messages: window, // Always bounded
});
```

**Why:** Unbounded history causes context overflows, slowdowns, and token waste.

---

### Anti-Pattern 4: Ignoring Streaming Errors

❌ **Wrong:**
```typescript
// Not checking for errors in stream
for await (const chunk of streamAgent(config)) {
  console.log(chunk); // Could be an error chunk
}
```

✅ **Right:**
```typescript
// Check every chunk type
for await (const chunk of streamAgent(config)) {
  if (chunk.type === "error") {
    console.error(`Agent error: ${chunk.message}`);
    // Decide: retry, fail, or recover
    break;
  } else if (chunk.type === "heartbeat") {
    // Reset idle timer, don't render
    continue;
  } else {
    // Regular output
    renderOutput(chunk);
  }
}
```

**Why:** Streaming errors can appear anywhere. Missing them leaves agents in bad states.

---

### Anti-Pattern 5: State Mutations Without Checkpointing

❌ **Wrong:**
```typescript
// Modifying agent state without saving
const state = await getThreadState(threadId);
state.messages.push(newMessage); // Memory only
// If the process crashes here, change is lost
await agent.run(state);
```

✅ **Right:**
```typescript
// Save before and after
const state = await getThreadState(threadId);
const saved = await addMessage(threadId, newMessage); // Persisted

try {
  const result = await agent.run(state);
  await recordCheckpoint(threadId, result); // Save state
} catch (error) {
  // Next run can resume from last checkpoint
  await saveErrorState(threadId, error);
  throw error;
}
```

**Why:** Without checkpointing, agent runs aren't resumable and state can be lost.

---

## 📁 File Structure

### Core Agent Orchestration
- `base.ts` — Type definitions (StreamChunk, AgentRunConfig, ToolPolicy)
- `run-thread.ts` — Main entry point for agent execution
- `llm.ts` — LangGraph agent creation, streaming integration
- `run-retry.ts` — Retry logic for transient failures

### State & Memory Management
- `run-registry.ts` — Active run tracking and lifecycle
- `run-thread.test.ts` — Integration tests for thread runs
- `conversation-summary.ts` — Thread text extraction
- `thread-compaction.ts` — Message pruning and summarization
- `warm-summary-background.ts` — Background refresh of old-message summaries

### Tool & Permission Management
- (Tool binding happens in `run-thread.ts`)
- (Permissions checked via `lib/stores/agent-configs.ts`)

### Budgeting & Resource Management
- `context-budget.ts` — Token budget calculation
- `delegation-budget.ts` — Cost tracking for delegated agents
- `usage-strategy.ts` — Model selection and output token limits
- `usage-profile.ts` — Cost/speed trade-off tracking

### Model & Routing
- `model-router.ts` — Choose model based on task complexity
- `effective-model.ts` — Resolve model config at runtime
- `prompt-registry.ts` — System prompt templates
- `prompt-variants.ts` — Alternative prompts per scenario

### Output & Validation
- `output-validator/` — Validate and format agent output
- `citation-checker.ts` — Track and validate source citations
- `hallucination-classifier.ts` — Detect and flag unsupported claims

### Checkpointing & Persistence
- `sqlite-checkpoint-saver.ts` — Persist agent state to SQLite
- `checkpointer.ts` — Checkpoint initialization
- `agent-turn.ts` — Turn-level metadata

### Helpers & Utilities
- `turn-profile.ts` — Metrics per turn (tokens, cost, time)
- `stream-collector.ts` — Collect streaming chunks into messages
- `tool-outcomes.ts` — Track tool execution results
- `thread-activity.ts` — Detect active conversations
- `tool-argument-delivery.ts` — Deliver tool arguments to tools

---

## 🧪 Testing Requirements

### Unit Tests (Per Module)

Every module needs focused unit tests:

```typescript
// lib/agents/model-router.test.ts
import { routeTurnModel } from "@/lib/agents/model-router";
import type { BaseMessage } from "@langchain/core/messages";

describe("model-router", () => {
  it("routes complex tasks to expensive models", async () => {
    const messages: BaseMessage[] = [
      { role: "user", content: "Analyze this 10-page research paper..." },
    ];
    
    const { model } = await routeTurnModel(messages, "complex-analysis");
    expect(model).toMatch(/opus|gpt-4/);
  });

  it("routes simple tasks to cheap models", async () => {
    const messages: BaseMessage[] = [
      { role: "user", content: "What's 2+2?" },
    ];
    
    const { model } = await routeTurnModel(messages, "simple");
    expect(model).toMatch(/haiku|gpt-3.5/);
  });
});
```

### Integration Tests (Thread-Level)

Test full agent runs with real database:

```typescript
// lib/agents/run-thread.test.ts
import { streamThreadRun } from "@/lib/agents/run-thread";
import { createTestThread } from "@/lib/stores/threads";

describe("streamThreadRun", () => {
  it("executes a complete agent turn", async () => {
    const threadId = await createTestThread();
    
    const chunks = [];
    for await (const chunk of streamThreadRun(threadId, "Search for Python docs", {})) {
      chunks.push(chunk);
    }
    
    expect(chunks.some(c => c.type === "tool_call")).toBe(true);
    expect(chunks.some(c => c.type === "tool_result")).toBe(true);
    expect(chunks[chunks.length - 1].type === "message_end").toBe(true);
  });

  it("recovers from transient errors", async () => {
    const threadId = await createTestThread();
    const errorOnce = jest.fn(() => {
      throw new RateLimitError("429");
    }).mockImplementationOnce(() => {
      throw new RateLimitError("429");
    });
    
    // Should retry and succeed
    const chunks = [];
    for await (const chunk of streamThreadRun(threadId, "Hello", {})) {
      chunks.push(chunk);
    }
    
    expect(errorOnce).toHaveBeenCalledTimes(2); // Called, failed, retried
  });
});
```

### Streaming Tests

Verify streaming output is properly formatted:

```typescript
// lib/agents/llm.test.ts - streaming
import { toBaseMessages } from "@/lib/agents/llm";

describe("toBaseMessages streaming", () => {
  it("converts streamed chunks to message stream", async () => {
    const stream = streamWithConfig(config);
    
    let messageCount = 0;
    for await (const chunk of stream) {
      if (chunk.type === "message_chunk") {
        messageCount++;
      }
    }
    
    expect(messageCount).toBeGreaterThan(0);
  });
});
```

### Tool Binding Tests

Verify tools are bound correctly:

```typescript
// lib/agents/run-thread.test.ts - tool binding
describe("bindToolsForAgent", () => {
  it("filters tools by permission list", async () => {
    const { bound } = await bindToolsForAgent("test-agent", [
      "search_web",
      "read_file",
    ]);
    
    expect(bound).toContain("search_web");
    expect(bound).toContain("read_file");
    expect(bound).not.toContain("delete_file");
  });

  it("injects per-tool credentials", async () => {
    const { tools } = await bindToolsForAgent("test-agent", ["github_search"]);
    
    const githubTool = tools.find(t => t.name === "github_search");
    expect(githubTool).toBeDefined();
    
    // Credential should be injected, not exposed
    expect(githubTool.description).not.toMatch(/token|secret|key/i);
  });
});
```

---

## 🎓 Common Mistakes & Fixes

### Mistake 1: Not Checking Agent Registry

**Problem:**
```typescript
// Typo in agent ID - agent doesn't exist
await streamThreadRun(threadId, msg, {
  agent_run_config: { model_config_name: "my-agent" }
});
// Fails at runtime: "Unknown agent"
```

**Fix:**
```typescript
// Validate agent before running
const agentDef = await getAgentConfig(agentId);
if (!agentDef) {
  throw new Error(`Agent ${agentId} not registered. Available: ${list...}`);
}

await streamThreadRun(threadId, msg, {
  agent_run_config: { model_config_name: agentId }
});
```

---

### Mistake 2: Ignoring Context Budget Errors

**Problem:**
```typescript
// Not checking if context fits
const window = allMessages.slice(-50); // Could be 200K tokens!
await agent.invoke({ messages: window }); // Provider error: context exceeded
```

**Fix:**
```typescript
// Use buildHistoryWindow which respects budget
const context = await computeContextBudget(model, config);
const window = buildHistoryWindow(threadId, {
  context_budget_tokens: context.max_input_tokens * 0.9, // Leave 10% margin
});

await agent.invoke({ messages: window }); // Always fits
```

---

### Mistake 3: Streaming Without Error Handling

**Problem:**
```typescript
// No error checks
for await (const chunk of streamWithConfig(config)) {
  send(chunk); // If chunk is an error, client gets confusing data
}
```

**Fix:**
```typescript
// Handle all chunk types
for await (const chunk of streamWithConfig(config)) {
  if (chunk.type === "error") {
    send({ type: "error", message: chunk.message });
    break;
  } else if (chunk.type !== "heartbeat") {
    send(chunk);
  }
}
```

---

### Mistake 4: Losing State on Crash

**Problem:**
```typescript
// No checkpointing
const state = { messages: [...] };
await agent.run(state); // Crashes mid-execution
// Next run has no idea where we left off - starts over
```

**Fix:**
```typescript
// Checkpoint before and after
await addMessage(threadId, userMessage); // Persisted
const checkpoint = await getCheckpointer().save(...);

try {
  for await (const chunk of streamWithConfig(config)) {
    yield chunk;
  }
  // Success - messages persisted automatically
} catch (error) {
  // State persisted up to point of error
  // Next run can resume from last checkpoint
  throw error;
}
```

---

### Mistake 5: Tool Credentials Exposed

**Problem:**
```typescript
// Leaking secrets in tool payload
const toolInput = {
  apiKey: credential.secret, // EXPOSED!
  query: userInput,
};

const result = await tool(toolInput);
// Could end up in logs, cache, output, etc.
```

**Fix:**
```typescript
// Use credential routing wrapper
const tools = wrapToolsForCredentialRouting(rawTools, {
  "github_search": credentialId,
});

// Tool receives credential ID, wrapper injects secret at call time
const result = await tool({
  credentialId: "cred_123", // Safe ID
  query: userInput,
});

// Inside tool wrapper:
// const secret = store.get(credentialId).token;
```

---

## ✅ Pre-PR Alignment Checklist

Before submitting a PR with agent changes, verify:

- [ ] **Agent runs are resumable**
  - [ ] State saved to database before/after execution
  - [ ] Crashes at any point can resume from checkpoint
  - [ ] No in-memory-only state that's not persisted

- [ ] **Tool permissions are enforced**
  - [ ] Allowed tools validated before binding
  - [ ] Credentials injected, never exposed in prompts
  - [ ] Permission check happens both at config and runtime

- [ ] **Streaming is error-safe**
  - [ ] All error cases checked in stream loop
  - [ ] No uncaught exceptions in streaming paths
  - [ ] Heartbeats don't break client parsing

- [ ] **Context is always bounded**
  - [ ] Message windows use buildHistoryWindow()
  - [ ] Token budgets respected (with margin)
  - [ ] No unbounded loops through all messages

- [ ] **Error recovery is tested**
  - [ ] Retryable errors trigger retry
  - [ ] Permanent errors fail cleanly
  - [ ] Stale state doesn't cause hangs

- [ ] **Model routing is explicit**
  - [ ] Model choice documented in code/comments
  - [ ] Fallback models defined
  - [ ] Capability gaps clearly marked

- [ ] **Tool execution is isolated**
  - [ ] Tool failures don't crash agent
  - [ ] Tool results captured in ToolMessage
  - [ ] Agent can recover from tool failures

- [ ] **Performance is acceptable**
  - [ ] No N+1 queries on tool binding
  - [ ] Message windowing keeps memory bounded
  - [ ] Streaming starts within 2 seconds

- [ ] **Tests cover new code**
  - [ ] Unit tests for new modules
  - [ ] Integration tests for thread-level changes
  - [ ] Streaming tests if touch async/generators
  - [ ] >90% coverage on changed files

- [ ] **Documentation is complete**
  - [ ] Code comments explain "why", not "what"
  - [ ] New patterns documented in this Agent.md
  - [ ] Breaking changes noted in CHANGELOG.md

---

## ❓ FAQ

**Q: How do I add a new agent to the system?**

A: Create a config in the database via `lib/stores/agent-configs.ts`, implement any custom nodes in `lib/agents/`, and register the agent in `run-registry.ts`. See the adapter pattern in `app/api/agents/create` for the UI flow.

---

**Q: How do I handle tool failures in agents?**

A: Tool failures are caught and returned as ToolMessage (not exceptions). The agent sees the failure and can retry, ask for clarification, or move on. Use `run-retry.ts` for transient errors (rate limits); ToolMessage for permanent tool failures.

---

**Q: What's the difference between "hot-load" and "lazy" tools?**

A: Hot-load tools are bound to the model (fast, used every run). Lazy tools require an extra `invoke_tool` hop. Use hot-load for essential tools (search, read_file); lazy for rare tools (export_pdf, share_link). Controlled by `isHotLoadTool()` in `lib/tools/runtime/registry.ts`.

---

**Q: How do I debug a streaming agent that hangs?**

A: Check: (1) last checkpoint — where did it stop? (2) is provider responding? (3) is a tool stuck? (4) is context budget exceeded? Use `run-registry.ts` idle detection and logs to find the stall point.

---

**Q: Can agents delegate to other agents?**

A: Yes, via the `delegate_to_agent` tool. It enforces depth limits (prevent infinite recursion), cost budgets (prevent runaway spending), and credential isolation (delegate sees only tools it's allowed). Configured in `delegation-budget.ts`.

---

**Q: How do I add streaming output to a tool?**

A: Tools can return `AsyncGenerator<string>` for streaming. See Pattern 3 in lib/tools/Agent.md. Agent collects chunks and streams them to client via SSE.

