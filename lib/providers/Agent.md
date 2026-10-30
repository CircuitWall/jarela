---
description: "Use when: implementing, debugging, or extending LLM provider adapters in lib/providers/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# LLM Provider Adapter Agent

**Specialization:** Building and maintaining LLM provider integrations (Anthropic, OpenAI, Google, Cohere, etc.) with proper credential handling, streaming, error recovery, and capability management.

**Scope:** `lib/providers/` directory — provider adapters, credential resolution, streaming implementations, rate-limit handling, and capability tracking.

---

## 🎯 Domain Context

### What Provider Adapters Are

A provider adapter bridges Jarela's agent runtime to an external LLM API:
- **Input:** Standardized messages (system, user, assistant, tool results)
- **Output:** Token stream or structured tool calls
- **Job:** Handle provider-specific auth, message formats, error codes, and rate limits

### Jarela's Provider Architecture

```
Agent (lib/agents/llm.ts)
  ↓ (standardized call)
Provider Interface (lib/providers/types.ts - ModelProvider)
  ↓ (provider-specific format)
Provider Adapter (lib/providers/anthropic.ts, openai.ts, etc.)
  ↓ (provider SDK)
External LLM API (Anthropic, OpenAI, etc.)
```

### Key Principles

1. **Credential Isolation**
   - API keys never in logs, prompts, or model context
   - Resolved at runtime via `resolveProviderApiKey()`
   - Per-integration credential storage in `lib/stores/integrations.ts`

2. **Streaming is Lazy**
   - Generators (AsyncIterable) for memory efficiency
   - Token-by-token to client (no buffering)
   - Errors can appear mid-stream

3. **Errors are Typed**
   - Auth errors → ProviderAuthError (requires reconfiguration)
   - Rate limits → RateLimitError (retry with backoff)
   - Transient → ProviderStreamError (retry immediately)
   - Permanent → fatal (fail)

4. **Capabilities are Explicit**
   - Each provider declares what it can do (vision, tools, JSON mode, etc.)
   - Agent uses this to choose models and request format
   - Unknown capability → fall back to safe default

5. **Message Formats Convert**
   - Jarela uses LangChain message format (universal)
   - Providers use native formats (Anthropic, OpenAI, Google, etc.)
   - Adapters convert one direction (messages → provider format)
   - Adapters convert back (provider output → events)

---

## 📋 Coding Patterns

### Pattern 1: Basic Provider Adapter

Every provider implements the `ModelProvider` interface:

```typescript
// lib/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ProviderMessage, ProviderParams } from "./types";

function resolveApiKey(params: ProviderParams): string | undefined {
  return resolveProviderApiKey("anthropic", params);
}

export const anthropicProvider: ModelProvider = {
  name: "anthropic",
  
  async chat(
    modelId: string,
    messages: ProviderMessage[],
    params: ProviderParams,
  ) {
    // 1. Create client with API key
    const client = new Anthropic({
      apiKey: resolveApiKey(params),
      baseURL: params.base_url,
    });

    // 2. Convert messages to Anthropic format
    const anthropicMessages = messages.map(msg => ({
      role: msg.role === "system" ? "user" : msg.role,
      content: typeof msg.content === "string" 
        ? msg.content 
        : msg.content.map(part => ...), // Convert ContentPart[]
    }));

    // 3. Call provider API
    const response = await client.messages.create({
      model: modelId,
      max_tokens: params.max_tokens ?? 4096,
      messages: anthropicMessages,
      system: extractSystemPrompt(messages),
      temperature: params.temperature,
      // ... other params
    });

    // 4. Return streaming result
    return {
      stream: toTokenStream(response),
    };
  },
};

// Helper: convert streaming response to token stream
async function* toTokenStream(response: Anthropic.Message): AsyncIterable<string> {
  for (const block of response.content) {
    if (block.type === "text") {
      yield block.text;
    }
  }
}
```

**When to use:** Adding a new provider (Anthropic, OpenAI, Google, etc.)

---

### Pattern 2: Streaming Tool Calls

Many providers stream tool arguments incrementally:

```typescript
// lib/providers/openai.ts
export async function* streamInvoke(
  modelId: string,
  messages: InvokeMessage[],
  params: ProviderParams,
  tools: OpenAITool[],
): AsyncIterable<ProviderStreamEvent> {
  const client = makeClient(params);

  // 1. Build request
  const request = {
    model: modelId,
    messages: messages.map(toOpenAIMessage),
    tools: tools.map(t => ({ type: "function", function: t })),
    stream: true,
    ...pickOpenAICompatOptions(params),
  };

  // 2. Stream from API
  const stream = await client.chat.completions.create(request as any);

  // 3. Yield typed events
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    
    if (delta?.content) {
      yield { type: "text", delta: delta.content };
    }

    if (delta?.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        yield {
          type: "tool_call_chunk",
          index: toolCall.index,
          id: toolCall.id,
          name: toolCall.function?.name,
          args_delta: toolCall.function?.arguments,
        };
      }
    }

    if (chunk.usage) {
      yield {
        type: "usage",
        input_tokens: chunk.usage.prompt_tokens,
        output_tokens: chunk.usage.completion_tokens,
      };
    }
  }
}
```

**When to use:** Streaming tool calls or thinking tokens from API responses

---

### Pattern 3: Error Handling & Retry Logic

Every provider must classify errors for intelligent retry:

```typescript
// lib/providers/errors.ts
export class ProviderAuthError extends Error {
  constructor(
    message: string,
    public provider: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ProviderStreamError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderStreamError";
  }
}

// In provider adapter:
export async function* streamWithErrorHandling(
  config: AgentRunConfig,
): AsyncIterable<ProviderStreamEvent> {
  try {
    yield* provider.streamInvoke(...);
  } catch (error) {
    // 1. Auth errors - don't retry, user must reconfigure
    if (error.status === 401 || error.status === 403) {
      throw new ProviderAuthError(
        `${provider} authorization failed: ${error.message}`,
        provider,
        error,
      );
    }

    // 2. Rate limits - retry with backoff
    if (error.status === 429) {
      const retryAfter = parseRetryAfter(error.headers);
      throw new RateLimitError(
        `${provider} rate limited`,
        retryAfter,
      );
    }

    // 3. Transient errors - retry immediately
    if ([408, 500, 502, 503, 504].includes(error.status)) {
      throw new ProviderStreamError(
        `${provider} temporary error: ${error.message}`,
        true, // retryable
      );
    }

    // 4. Other errors - fail
    throw new ProviderStreamError(
      `${provider} error: ${error.message}`,
      false,
    );
  }
}
```

**When to use:** Wrapping provider calls to handle auth failures, rate limits, and transient errors

---

### Pattern 4: Capability Declaration

Let the agent know what this provider can do:

```typescript
// lib/providers/capabilities.ts
export function modelCapabilities(providerId: string, modelId: string) {
  const capabilities = {
    vision: false,
    tools: false,
    streaming: true,
    json_mode: false,
    web_search: false,
    audio: false,
    files: false,
  };

  // Anthropic capabilities
  if (providerId === "anthropic") {
    if (modelId.includes("opus") || modelId.includes("sonnet")) {
      capabilities.tools = true;
      capabilities.json_mode = true;
      capabilities.vision = true;
    }
  }

  // OpenAI capabilities
  if (providerId === "openai") {
    if (modelId.includes("gpt-4") || modelId.includes("gpt-5")) {
      capabilities.tools = true;
      capabilities.json_mode = true;
      capabilities.vision = true;
    }
  }

  return capabilities;
}

// Agent uses this:
const caps = modelCapabilities("anthropic", "claude-opus-5");
if (caps.tools) {
  // Can use tool_use blocks
} else {
  // Use function_calling alternative
}
```

**When to use:** Declaring what features a model supports

---

### Pattern 5: Credential Resolution with Fallbacks

Resolve API keys from environment, config, or store:

```typescript
// lib/providers/credentials.ts
export function resolveProviderApiKey(
  providerId: string,
  params: ProviderParams,
): string | undefined {
  // 1. Explicit params (highest priority)
  if (params.api_key) return params.api_key;

  // 2. Environment variables (namespaced by provider)
  const envKey = `${providerId.toUpperCase()}_API_KEY`;
  if (process.env[envKey]) return process.env[envKey];

  // 3. Credential store (per-integration)
  const stored = getStoredCredential(providerId);
  if (stored?.apiKey) return stored.apiKey;

  // 4. Not found
  throw new ProviderAuthError(
    `No API key found for ${providerId}. ` +
    `Set JARELA_${envKey} or configure in settings.`,
    providerId,
  );
}
```

**When to use:** Resolving secrets safely without exposing them

---

## ⚠️ Anti-Patterns (What NOT to Do)

### Anti-Pattern 1: API Keys in Code or Logs

❌ **Wrong:**
```typescript
// NEVER hardcode keys
const anthropicKey = "sk-ant-xxx";

// NEVER log them
console.log("Using API key:", apiKey);

// NEVER expose in error messages
throw new Error(`Auth failed with key ${apiKey}: ${error}`);
```

✅ **Right:**
```typescript
// Always resolve from secure source
const apiKey = resolveProviderApiKey(providerId, params);

// Never log the key itself
if (DEBUG) console.log(`Auth attempt for provider: ${providerId}`);

// Error messages don't mention the key
throw new ProviderAuthError(`${providerId} authentication failed`, providerId);
```

**Why:** Keys in logs persist forever. They can be found in backups, caches, or version control.

---

### Anti-Pattern 2: Assuming Message Format

❌ **Wrong:**
```typescript
// Assuming all messages have a "content" string
const anthropicMessages = messages.map(m => ({
  role: m.role,
  content: m.content, // ContentPart[] won't serialize!
}));
```

✅ **Right:**
```typescript
// Handle both string and ContentPart[]
const anthropicMessages = messages.map(m => ({
  role: m.role,
  content: typeof m.content === "string"
    ? m.content
    : m.content.map(part => toAnthropicContent(part)),
}));

function toAnthropicContent(part: ContentPart): Anthropic.ContentBlockParam {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  } else if (part.type === "image") {
    return {
      type: "image",
      source: { type: "url", url: part.url },
    };
  }
  // ... handle other types
}
```

**Why:** Providers support different content types. Always convert explicitly.

---

### Anti-Pattern 3: Not Classifying Errors

❌ **Wrong:**
```typescript
// Same retry strategy for all errors
try {
  yield* provider.streamInvoke(...);
} catch (error) {
  // Retry everything?
  throw error;
}
```

✅ **Right:**
```typescript
// Classify errors before deciding to retry
try {
  yield* provider.streamInvoke(...);
} catch (error) {
  if (error.status === 401) {
    throw new ProviderAuthError(...); // Don't retry
  } else if (error.status === 429) {
    throw new RateLimitError(..., retryAfter); // Retry with backoff
  } else if ([500, 502, 503].includes(error.status)) {
    throw new ProviderStreamError(..., true); // Retry immediately
  } else {
    throw new ProviderStreamError(..., false); // Don't retry
  }
}
```

**Why:** Retrying auth errors wastes time and may trigger account locks.

---

### Anti-Pattern 4: Buffering Entire Streams

❌ **Wrong:**
```typescript
// Buffering all tokens before returning
const allTokens = [];
for await (const token of stream) {
  allTokens.push(token);
}
return allTokens.join(""); // OOM on large responses
```

✅ **Right:**
```typescript
// Streaming tokens progressively
async function* streamTokens(apiStream) {
  for await (const chunk of apiStream) {
    for (const token of chunk.tokens) {
      yield token; // Yield immediately
    }
  }
}
```

**When to use:** Large streaming responses

---

### Anti-Pattern 5: Ignoring Provider-Specific Formats

❌ **Wrong:**
```typescript
// Treating all messages the same
const request = {
  messages: messages.map(m => ({ role: m.role, content: m.content })),
};

// Each provider has different expectations:
// - Anthropic: separate "system" parameter
// - OpenAI: system message in messages array
// - Google: different format for images
```

✅ **Right:**
```typescript
// Provider-specific formatting
export async function* toAnthropicMessages(
  messages: ProviderMessage[],
): { system?: string; messages: Anthropic.Message[] } {
  let system: string | undefined;
  const rest: Anthropic.Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content as string;
    } else {
      rest.push(toAnthropicMessage(msg));
    }
  }

  return { system, messages: rest };
}
```

**Why:** Providers have different APIs. Respecting them prevents subtle bugs.

---

## 📁 File Structure

### Core Adapters
- `anthropic.ts` — Anthropic Claude provider
- `openai.ts` — OpenAI GPT provider
- `google.ts` / `gemini.ts` — Google Gemini provider
- `cohere.ts` / `external.ts` — Cohere and custom external providers
- `github-copilot.ts` — GitHub Copilot provider
- `deepseek.ts` — DeepSeek provider

### Infrastructure
- `types.ts` — `ModelProvider` interface and types (public API)
- `credentials.ts` — API key resolution with fallbacks
- `errors.ts` — Error classification (auth, rate limit, transient)
- `rate-limit.ts` — Rate limit tracking and backoff calculation
- `capabilities.ts` — Model capability discovery and declarations
- `known-context-windows.ts` — Context/output token limits per model

### Integration & Helpers
- `index.ts` — Provider registry and getProvider() factory
- `registry.ts` — In-tree and external provider loading
- `jarela-chat-model.ts` — LangChain adapter (wraps providers for LangGraph)
- `langchain.ts` — LangChain integration helpers
- `streaming.ts` — Common streaming utilities
- `tool-arguments.ts` — Tool argument parsing and truncation
- `tool-limit.ts` — Per-provider tool limit enforcement
- `provider-integration-map.ts` — Credential mapping

### Testing & Examples
- `*.test.ts` — Unit tests for each provider
- `template-external.cjs.example` — Template for external provider plugins

---

## 🧪 Testing Requirements

### Unit Tests: Provider Adapter

Every provider needs focused tests:

```typescript
// lib/providers/anthropic.test.ts
import { anthropicProvider } from "@/lib/providers/anthropic";
import type { ProviderMessage } from "@/lib/providers/types";

describe("anthropic provider", () => {
  it("converts messages to Anthropic format", async () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const { stream } = await anthropicProvider.chat(
      "claude-opus-5",
      messages,
      { api_key: "test" },
    );

    // Should create AsyncIterable<string>
    const tokens = [];
    for await (const token of stream) {
      tokens.push(token);
    }

    expect(tokens.length).toBeGreaterThan(0);
  });

  it("handles system messages", async () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];

    const { stream } = await anthropicProvider.chat(
      "claude-opus-5",
      messages,
      { api_key: "test" },
    );

    // System message should be extracted
    // (verify by mocking Anthropic SDK)
  });
});
```

### Unit Tests: Error Handling

```typescript
// lib/providers/errors.test.ts
import { ProviderAuthError, RateLimitError } from "@/lib/providers/errors";

describe("error classification", () => {
  it("identifies 401 as ProviderAuthError", () => {
    const error = createMockApiError(401);
    const classified = classifyProviderError(error);

    expect(classified).toBeInstanceOf(ProviderAuthError);
    expect(classified.retryable).toBe(false);
  });

  it("identifies 429 as RateLimitError", () => {
    const error = createMockApiError(429, { "retry-after": "60" });
    const classified = classifyProviderError(error);

    expect(classified).toBeInstanceOf(RateLimitError);
    expect(classified.retryAfterMs).toBe(60000);
  });
});
```

### Integration Tests: Streaming

```typescript
// lib/providers/integration.test.ts
describe("streaming providers", () => {
  it("yields events in order", async () => {
    const events = [];
    for await (const evt of provider.streamInvoke(...)) {
      events.push(evt.type);
    }

    // Should see text, usage, stop in order
    expect(events).toContain("text");
    expect(events[events.length - 1]).toBe("stop");
  });

  it("handles mid-stream errors", async () => {
    const errorStream = mockStreamError(500, "Internal Server Error");

    let errorCaught = false;
    try {
      for await (const evt of errorStream) {
        // Keep consuming
      }
    } catch (error) {
      errorCaught = true;
      expect(error).toBeInstanceOf(ProviderStreamError);
    }

    expect(errorCaught).toBe(true);
  });
});
```

---

## 🎓 Common Mistakes & Fixes

### Mistake 1: Forgetting to Resolve Credentials

**Problem:**
```typescript
// Using undefined API key
const client = new Anthropic({ apiKey: params.api_key }); // undefined!
// Error: "No API key provided"
```

**Fix:**
```typescript
// Always resolve before using
const apiKey = resolveProviderApiKey("anthropic", params);
if (!apiKey) {
  throw new ProviderAuthError("No Anthropic API key configured", "anthropic");
}

const client = new Anthropic({ apiKey });
```

---

### Mistake 2: Converting Message Formats Incorrectly

**Problem:**
```typescript
// Assuming all messages are strings
const openaiMessages = messages.map(m => ({
  role: m.role,
  content: m.content, // Breaks if ContentPart[]
}));
```

**Fix:**
```typescript
// Handle all content types
const openaiMessages = messages.map(m => ({
  role: m.role,
  content: toOpenAIContent(m.content), // Convert explicitly
}));

function toOpenAIContent(content: string | ContentPart[]): OpenAI.ChatCompletionContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") return { type: "image_url", image_url: { url: part.url } };
    // ...
  });
}
```

---

### Mistake 3: Not Handling Streaming Errors

**Problem:**
```typescript
// Error mid-stream is silently dropped
for await (const chunk of stream) {
  yield chunk;
  // If error occurs here, it's lost
}
```

**Fix:**
```typescript
// Catch and classify errors
try {
  for await (const chunk of stream) {
    yield chunk;
  }
} catch (error) {
  if (error.status === 401) {
    throw new ProviderAuthError(...);
  } else if (error.status === 429) {
    throw new RateLimitError(...);
  } else {
    throw new ProviderStreamError(...);
  }
}
```

---

### Mistake 4: Exposing Secrets in Error Messages

**Problem:**
```typescript
// Key leaked in error log
console.error(`Failed with key ${apiKey}: ${error.message}`);
```

**Fix:**
```typescript
// Never mention the key
console.error(`Authentication failed for ${providerId}. Check credentials.`);
```

---

### Mistake 5: Not Testing Error Paths

**Problem:**
```typescript
// Only testing happy path
const tokens = [];
for await (const token of provider.chat(...)) {
  tokens.push(token);
}
// Never tested what happens if provider returns 429
```

**Fix:**
```typescript
// Test error scenarios
it("retries on 429", async () => {
  const stream = mockProviderError(429);
  expect(() => provider.chat(...)).toThrow(RateLimitError);
});

it("doesn't retry on 401", async () => {
  const stream = mockProviderError(401);
  expect(() => provider.chat(...)).toThrow(ProviderAuthError);
});
```

---

## ✅ Pre-PR Alignment Checklist

Before submitting a PR with provider changes, verify:

- [ ] **Credentials are never exposed**
  - [ ] No API keys in code, logs, or error messages
  - [ ] resolveProviderApiKey() used for all secrets
  - [ ] No credential objects passed to tools

- [ ] **Message conversion is complete**
  - [ ] All content types handled (text, image, file, etc.)
  - [ ] Provider-specific format applied correctly
  - [ ] System prompts extracted/positioned per provider

- [ ] **Error handling is comprehensive**
  - [ ] Auth errors (401/403) detected and not retried
  - [ ] Rate limits (429) detected with retry-after parsed
  - [ ] Transient errors (5xx) detected and retried
  - [ ] Permanent errors fail cleanly with context

- [ ] **Streaming is efficient**
  - [ ] No buffering (tokens yielded immediately)
  - [ ] Errors caught mid-stream
  - [ ] Tool calls streamed as fragments
  - [ ] Usage events emitted

- [ ] **Capabilities are declared**
  - [ ] modelCapabilities() returns accurate flags
  - [ ] Unsupported capabilities default safely
  - [ ] Agent can query capabilities before using

- [ ] **Rate limits are tracked**
  - [ ] Rate limit headers parsed and stored
  - [ ] Next-available-slot calculated
  - [ ] Multiple concurrent requests coordinated

- [ ] **Tests are thorough**
  - [ ] Happy path: message conversion, token streaming
  - [ ] Error paths: all classified errors tested
  - [ ] Edge cases: empty messages, large content, mid-stream failure
  - [ ] Credentials: ensure no leaks in test output

- [ ] **Documentation is complete**
  - [ ] API key setup documented
  - [ ] Capabilities list up-to-date
  - [ ] Known issues or workarounds noted
  - [ ] Provider-specific quirks explained

- [ ] **Backwards compatibility**
  - [ ] External provider plugins still work
  - [ ] No breaking changes to ModelProvider interface
  - [ ] Existing model configs still load

---

## ❓ FAQ

**Q: How do I add a new provider?**

A: Create `lib/providers/[name].ts` implementing `ModelProvider`. Register it in `lib/providers/registry.ts`. Add tests in `lib/providers/[name].test.ts`. See anthropic.ts as a template.

---

**Q: How do I debug a streaming provider issue?**

A: Enable debug logging via `DEBUG=jarela:providers:*`. Check: (1) Is API key resolved? (2) Is message format correct? (3) Is error classified? (4) Is stream consumed correctly?

---

**Q: How do I support tool calling for a new provider?**

A: Implement `invoke()` and `streamInvoke()` in ModelProvider. Convert tools to provider format. Yield `tool_call_chunk` events as arguments stream. See openai.ts and anthropic.ts for examples.

---

**Q: How do I handle provider-specific parameters?**

A: Add to `ProviderParams` interface. Use `pickProviderOptions()` to extract params. Convert to provider SDK format. Example: `temperature` → `Anthropic.temperate`, `thinking` → `output_config.effort`.

---

**Q: Can I use a custom/self-hosted model endpoint?**

A: Yes, via `params.base_url`. Most providers support `base_url` override. Create a custom provider adapter in `~/.jarela/providers/[name].cjs` if needed. See `template-external.cjs.example`.

