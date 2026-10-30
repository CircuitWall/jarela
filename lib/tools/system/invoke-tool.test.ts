import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import type { ToolConfig } from "../filesystem/workspace-context";
import { currentWorkspace, reportToolProgress } from "../filesystem/workspace-context";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-invoke-tool-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { invokeToolTool, SELF_INVOKE_MESSAGE } = await import("./invoke-tool");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { executeTool } = await import("../index");
const { registerTools, registeredTools } = await import("../runtime/registry");
const { getAsyncResult } = await import("../support/async-results");
const { getCurrentToolCredentialContext } = await import("../security/credential-context");

afterEach(() => {
  vi.useRealTimers();
});

interface InvokeResult {
  ok: boolean;
  tool: string;
  status: "done" | "rejected" | "error";
  result?: unknown;
  error_code?: string;
  permission_reason?: string | null;
}

function parse(value: unknown): InvokeResult {
  return JSON.parse(String(value)) as InvokeResult;
}

describe("invoke_tool", () => {
  it.each([
    ["object", { ok: true, nested: { values: [1, null, false] } }],
    ["array", ["a", 2, { value: true }]],
    ["text", "plain text\nwith \"quotes\" and a backslash \\"],
    ["false", false],
    ["null", null],
    ["target_error", { ok: false, error_code: "synthetic_target_error", error: "Target rejected the operation", details: { field: "value" } }],
  ])("preserves direct-call output for %s results through both argument carriers", async (suffix, value) => {
    const name = `proxy_parity_${suffix}`;
    registerTools("Files", "read", [tool(async ({ input }) => {
      expect(input).toBe("normalized");
      return typeof value === "string" ? value : JSON.stringify(value);
    }, {
      name, description: "Synthetic result parity",
      schema: z.object({ input: z.string().trim().default("normalized") }),
    })]);
    const args = { input: "  normalized  " };
    const direct = await executeTool(name, args);
    for (const carrier of [{ args }, { args_json: JSON.stringify(args) }]) {
      expect(await executeTool("invoke_tool", { name, ...carrier })).toEqual({
        ok: true, tool: name, status: "done", result: direct,
      });
    }
  });

  it("does not serialize independent target calls behind the proxy", async () => {
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => { bothStarted = resolve; });
    const finishes = new Map<string, (value: string) => void>();
    registerTools("Files", "read", [tool(async ({ value }) => new Promise<string>((resolve) => {
      finishes.set(value, resolve);
      if (finishes.size === 2) bothStarted();
    }), {
      name: "proxy_concurrent_target", description: "Synthetic concurrent target", schema: z.object({ value: z.string() }),
    })]);
    const first = executeTool("invoke_tool", { name: "proxy_concurrent_target", args: { value: "first" } });
    const second = executeTool("invoke_tool", { name: "proxy_concurrent_target", args: { value: "second" } });
    await ready;
    finishes.get("second")?.('{"value":"second"}');
    finishes.get("first")?.('{"value":"first"}');
    expect(await Promise.all([first, second])).toMatchObject([
      { result: { value: "first" } }, { result: { value: "second" } },
    ]);
  });

  it("does not impose a second default deadline on a longer target call", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    registerTools("Files", "read", [tool(async () => {
      started();
      return new Promise<string>((resolve) => { finish = resolve; });
    }, { name: "proxy_long_target", description: "Synthetic long target", schema: z.object({}) })]);
    let settled = false;
    const work = executeTool("invoke_tool", {
      name: "proxy_long_target", args: { deadline_ms: 200_000 },
    }).then((result) => { settled = true; return result; });
    await ready;
    await vi.advanceTimersByTimeAsync(120_001);
    expect(settled).toBe(false);
    finish('{"value":"finished"}');
    expect(await work).toMatchObject({ status: "done", result: { value: "finished" } });
  });

  it("preserves workspace, progress correlation and arbitrary trusted run context", async () => {
    const writer = vi.fn();
    registerTools("Files", "read", [tool(async (_, config) => {
      reportToolProgress(config as ToolConfig, "proxy_context_target", "working");
      return JSON.stringify({
        workspace: currentWorkspace(config as ToolConfig),
        custom: config?.configurable?.custom_run_value,
        budget: config?.configurable?.tool_result_max_bytes,
        depth: config?.configurable?.delegation_depth,
      });
    }, { name: "proxy_context_target", description: "Synthetic context target", schema: z.object({}) })]);
    const config: RunnableConfig & ToolConfig = {
      writer, toolCallId: "proxy-call",
      configurable: {
        workspace: { root: tmpRoot, scoped: true, opened_at: 123 },
        custom_run_value: "preserved", tool_result_max_bytes: 4096, delegation_depth: 2,
      },
    };
    const out = await executeTool("invoke_tool", { name: "proxy_context_target", stream: true }, {}, config);
    const overhead = Buffer.byteLength(JSON.stringify({ ok: true, tool: "proxy_context_target", status: "done", result: null })) - 4;
    expect(out).toMatchObject({
      status: "done",
      result: { workspace: config.configurable?.workspace, custom: "preserved", budget: 4096 - overhead, depth: 2 },
    });
    expect(writer).toHaveBeenCalledWith({ id: "proxy-call", name: "proxy_context_target", text: "working" });
  });

  it("applies top-level execution controls to the target, with target arguments taking precedence", async () => {
    const writer = vi.fn();
    registerTools("Files", "read", [tool(async (_, config) => {
      reportToolProgress(config as ToolConfig, "proxy_controls_target", "working");
      return '{"value":"ok"}';
    }, { name: "proxy_controls_target", description: "Synthetic controls target", schema: z.object({}) })]);
    const out = await executeTool("invoke_tool", {
      name: "proxy_controls_target", async_run: true, stream: false,
      args: { async_run: false, stream: true },
    }, {}, { writer } as RunnableConfig);
    expect(out).toMatchObject({ status: "done", result: { value: "ok" } });
    expect(writer).toHaveBeenCalledOnce();
    const quiet = await executeTool("invoke_tool", { name: "proxy_controls_target", stream: false }, {}, { writer } as RunnableConfig);
    expect(quiet).toMatchObject({ status: "done" });
    expect(writer).toHaveBeenCalledOnce();
  });

  it("returns a single background receipt owned by the target, not the proxy", async () => {
    let finish!: (value: string) => void;
    registerTools("Files", "read", [tool(async () =>
      new Promise<string>((resolve) => { finish = resolve; }),
    { name: "proxy_async_target", description: "Synthetic async target", schema: z.object({}) })]);
    const out = await executeTool("invoke_tool", { name: "proxy_async_target", async_run: true });
    expect(out).toMatchObject({ status: "done", result: { async: true, tool: "proxy_async_target" } });
    const receipt = out as { result: { key: string } };
    expect(getAsyncResult(receipt.result.key)?.tool).toBe("proxy_async_target");
    finish('{"value":"done"}');
    await vi.waitFor(() => expect(getAsyncResult(receipt.result.key)?.status).toBe("done"));
  });

  it("returns target schema errors as caller errors without weakening argument validation", async () => {
    const out = await executeTool("invoke_tool", { name: "file_grep", args: { pattern: "test", context: 6 } });
    expect(out).toMatchObject({
      status: "error", error_code: "invalid_tool_arguments",
      error: expect.stringContaining("context"),
    });
  });

  it("preserves the proxy response shape when LangGraph supplies a tool-call envelope", async () => {
    const proxy = registeredTools().find((entry) => entry.name === "invoke_tool");
    if (!proxy) throw new Error("invoke_tool must be registered");
    const out = await proxy.invoke({
      type: "tool_call", id: "graph-proxy-call", name: "invoke_tool",
      args: { name: "list_tools", args: { query: "file_grep" } },
    });
    expect(out).toHaveProperty("tool_call_id", "graph-proxy-call");
    if (!out || typeof out !== "object" || !("content" in out)) throw new Error("Expected a ToolMessage");
    expect(JSON.parse(String(out.content))).toMatchObject({
      tool: "list_tools", status: "done", result: { counts: { total: expect.any(Number) } },
    });
  });

  it("enforces the target deadline when supplied on the proxy", async () => {
    let finish!: (value: string) => void;
    registerTools("Files", "read", [tool(async () =>
      new Promise<string>((resolve) => { finish = resolve; }),
    { name: "proxy_timeout_target", description: "Synthetic timeout target", schema: z.object({}) })]);
    const out = await executeTool("invoke_tool", { name: "proxy_timeout_target", deadline_ms: 10 });
    expect(out).toMatchObject({
      status: "done", result: { error_code: "tool_timeout", deadline_ms: 10, message: expect.stringContaining("proxy_timeout_target") },
    });
    finish('{"value":"late"}');
  });

  it.each([false, true])("retains coordinator-owned settlement through proxy deadlines and cancellation (async_run=%s)", async (asyncRun) => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const name = `proxy_settlement_target_${asyncRun}`;
    registerTools("Files", "read", [tool(async () => {
      started();
      return new Promise<string>((resolve) => { finish = resolve; });
    }, { name, description: "Synthetic settlement target", schema: z.object({}) })]);
    let settled = false;
    const work = executeTool("invoke_tool", { name, args: { deadline_ms: 1, async_run: asyncRun } }, {
      await_tool_settlement: true, signal: controller.signal,
    }).then((result) => { settled = true; return result; });
    await ready;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finish('{"value":"settled"}');
    expect(await work).toMatchObject({ status: "done", result: { value: "settled" } });
  });

  it("forwards caller cancellation to the target", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    registerTools("Files", "read", [tool(async (_, config) => {
      started();
      return new Promise<string>((_, reject) => {
        config?.signal?.addEventListener("abort", () => reject(new Error("Target cancelled")), { once: true });
      });
    }, { name: "proxy_cancel_target", description: "Synthetic cancellation target", schema: z.object({}) })]);
    const work = executeTool("invoke_tool", { name: "proxy_cancel_target" }, { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow();
    await ready;
    controller.abort();
    await rejected;
  });

  it("keeps internal validation failures classified as target failures", async () => {
    registerTools("Files", "read", [tool(async () => {
      throw new Error("Response schema validation failed");
    }, { name: "proxy_invalid_response", description: "Synthetic invalid response", schema: z.object({}) })]);
    expect(await executeTool("invoke_tool", { name: "proxy_invalid_response" })).toMatchObject({
      status: "error", error_code: "target_tool_failed", error: "Response schema validation failed",
    });
  });

  it("preserves the target's large-result reference without another proxy spill", async () => {
    registerTools("Files", "read", [tool(async () => "x".repeat(20_000),
      { name: "proxy_large_result", description: "Synthetic large result", schema: z.object({}) })]);
    const out = await executeTool("invoke_tool", { name: "proxy_large_result" });
    expect(out).toMatchObject({
      tool: "proxy_large_result", status: "done",
      result: { truncated: true, tool: "proxy_large_result", bytes: 20_000, result_ref: { name: expect.any(String) } },
    });
    expect(out).not.toHaveProperty("result_ref");
  });

  it("preserves nested credential overrides in the target credential-routing scope", async () => {
    registerTools("Files", "read", [tool(async () => JSON.stringify(getCurrentToolCredentialContext()),
      { name: "proxy_credentials_target", description: "Synthetic credential context", schema: z.object({}) })]);
    const config: RunnableConfig = {
      configurable: { agent_run_config: { tool_credentials: { proxy_credentials_target: "synthetic-credential" } } },
    };
    expect(await executeTool("invoke_tool", { name: "proxy_credentials_target" }, {}, config)).toMatchObject({
      status: "done", result: { toolName: "proxy_credentials_target", toolCredentials: { proxy_credentials_target: "synthetic-credential" } },
    });
  });

  it("does not turn a completion-turn read into new background work", async () => {
    registerTools("Files", "read", [tool(async () => '{"value":"completion"}',
      { name: "proxy_completion_target", description: "Synthetic completion read", schema: z.object({}) })]);
    expect(await executeTool("invoke_tool", { name: "proxy_completion_target", async_run: true }, {
      signal_continuation: true,
    })).toMatchObject({ status: "done", result: { value: "completion" } });
  });

  it("cannot proxy a restart denied by the read-only completion overlay", async () => {
    upsertAgentConfig({ id: "completion-proxy", name: "Completion Proxy", identity: "test", instructions: "", tools: ["restart_server"] });
    const thread = createThread("completion-proxy");
    const out = parse(await invokeToolTool.invoke(
      { name: "restart_server", args: { reason: "old restart request" } },
      { configurable: { thread_id: thread.thread_id, signal_continuation: true,
        tool_permission_map: [{ name: "restart_server", permission: "disabled", permission_reason: "signal_continuation_read_only" }] } },
    ));
    expect(out).toMatchObject({ ok: false, status: "rejected", error_code: "tool_not_allowed", permission_reason: "signal_continuation_read_only" });
  });

  it("warns the model not to recursively wrap invoke_tool", () => {
    expect(invokeToolTool.description).toContain("Never use invoke_tool to call invoke_tool itself");
    expect(invokeToolTool.description).toContain("call already-loaded tools directly");
  });

  it("advertises target-owned execution controls in the model-facing tool definition", () => {
    const definition = convertToOpenAITool(invokeToolTool).function;
    expect(definition.description).toContain("values inside args or args_json take precedence");
    expect(definition.parameters?.properties).toMatchObject({
      deadline_ms: expect.any(Object), async_run: expect.any(Object), stream: expect.any(Object),
    });
  });

  it("rejects recursive self-invocation", async () => {
    await expect(invokeToolTool.invoke({ name: "invoke_tool", args: {} }))
      .rejects.toThrow("invoke_tool cannot target itself");
  });

  it("rejects invoke_tool as a schema target before execution", () => {
    const parsed = invokeToolTool.schema.safeParse({ name: "invoke_tool", args: {} });

    expect(parsed.success).toBe(false);
  });

  it("uses identical wording for the schema-level and runtime self-invoke rejections", async () => {
    // Telemetry showed agents retrying because these two rejection paths
    // used to say different things ("cannot target itself" vs "cannot
    // invoke itself") for the exact same mistake. Both must now share
    // SELF_INVOKE_MESSAGE so there is only one error to recognize.
    const schemaResult = invokeToolTool.schema.safeParse({ name: "invoke_tool", args: {} });
    expect(schemaResult.success).toBe(false);
    if (!schemaResult.success) {
      expect(schemaResult.error.issues[0]?.message).toBe(SELF_INVOKE_MESSAGE);
    }

    await expect(invokeToolTool.invoke({ name: "invoke_tool", args: {} }))
      .rejects.toThrow(SELF_INVOKE_MESSAGE);
  });

  it("rejects tools that are not enabled for the current agent", async () => {
    upsertAgentConfig({
      id: "invoke-denied-agent",
      name: "Invoke Denied",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-denied-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "gmail_search", args: { query: "from:anyone" } },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out).toMatchObject({
      ok: false,
      tool: "gmail_search",
      status: "rejected",
      error_code: "tool_not_allowed",
      permission_reason: "agent_not_allowed",
    });
  });

  it("executes an otherwise-enabled tool omitted only by the provider cap", async () => {
    upsertAgentConfig({
      id: "invoke-capped-agent",
      name: "Invoke Capped",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-capped-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "list_tools", args: { query: "invoke_tool" } },
      {
        configurable: {
          thread_id: thread.thread_id,
          agent_run_config: {
            tool_permission_map: [
              {
                name: "list_tools",
                permission: "disabled",
                permission_reason: "provider_tool_limit",
              },
            ],
          },
        },
      },
    ));

    expect(out).toMatchObject({
      ok: true,
      tool: "list_tools",
      status: "done",
    });
    expect(out.result).toMatchObject({
      counts: expect.objectContaining({ total: expect.any(Number) }),
    });
  });

  it("executes a permitted tool that was left unbound as proxy_only", async () => {
    upsertAgentConfig({
      id: "invoke-proxy-agent",
      name: "Invoke Proxy",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-proxy-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "list_tools", args: { query: "invoke_tool" } },
      {
        configurable: {
          thread_id: thread.thread_id,
          agent_run_config: {
            tool_permission_map: [
              { name: "list_tools", permission: "disabled", permission_reason: "proxy_only" },
            ],
          },
        },
      },
    ));

    expect(out).toMatchObject({ ok: true, tool: "list_tools", status: "done" });
  });

  it("still rejects a tool the agent is not permitted to use", async () => {
    upsertAgentConfig({
      id: "invoke-proxy-denied-agent",
      name: "Invoke Proxy Denied",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-proxy-denied-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "gmail_search", args: { query: "from:anyone" } },
      {
        configurable: {
          thread_id: thread.thread_id,
          agent_run_config: {
            tool_permission_map: [
              { name: "gmail_search", permission: "disabled", permission_reason: "agent_not_allowed" },
            ],
          },
        },
      },
    ));

    expect(out).toMatchObject({
      ok: false,
      status: "rejected",
      error_code: "tool_not_allowed",
    });
  });

  it("carries arguments through args_json for schema-restricted providers", async () => {
    upsertAgentConfig({
      id: "invoke-argsjson-agent",
      name: "Invoke ArgsJson",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-argsjson-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "list_tools", args_json: JSON.stringify({ query: "invoke_tool" }) },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out).toMatchObject({ ok: true, tool: "list_tools", status: "done" });
    expect(out.result).toMatchObject({
      counts: expect.objectContaining({ total: expect.any(Number) }),
    });
  });

  it("reports a usable error when args_json is not a JSON object", async () => {
    upsertAgentConfig({
      id: "invoke-badjson-agent",
      name: "Invoke BadJson",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-badjson-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "list_tools", args_json: "not json" },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out).toMatchObject({ status: "rejected", error_code: "bad_args_json" });
  });

  it("exposes args_json as a plain string so provider schema sanitisers keep it", () => {
    const schema = invokeToolTool.schema as { shape?: Record<string, unknown> };
    expect(schema.shape).toHaveProperty("args_json");
    expect(invokeToolTool.description).toContain("args_json");
  });

  it("still accepts structured args directly — resolveArgs prefers it over args_json when populated", async () => {
    upsertAgentConfig({
      id: "invoke-structured-args-agent",
      name: "Invoke Structured Args",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-structured-args-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "list_tools", args: { query: "invoke_tool" } },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out).toMatchObject({ ok: true, tool: "list_tools", status: "done" });
  });

  // Structured `args` is strictly more reliable than a hand-escaped JSON
  // string for any provider that supports free-form object schemas
  // (Anthropic, OpenAI) — only Gemini's schema sanitiser forces args_json
  // (sanitizeGeminiSchema strips additionalProperties, leaving `args`
  // emittable only as `{}`). The description must not steer every model
  // toward the strictly worse string-encoding path just to accommodate
  // Gemini; `args` is the primary field, args_json the fallback.
  it("presents structured args as primary, not deprecated — args_json is the fallback for providers that can't emit a free-form object", () => {
    expect(invokeToolTool.description).not.toMatch(/deprecated/i);
    const argsIdx = invokeToolTool.description.indexOf("Prefer args");
    const argsJsonFallbackIdx = invokeToolTool.description.indexOf("args_json");
    expect(argsIdx).toBeGreaterThanOrEqual(0);
    expect(argsJsonFallbackIdx).toBeGreaterThan(argsIdx);
  });
});
