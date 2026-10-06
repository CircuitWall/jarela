import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const root = mkdtempSync(join(tmpdir(), "jarela-signal-contract-"));
process.env.JARELA_DB_DIR = root;
const model = vi.hoisted(() => vi.fn());
vi.mock("@/lib/scheduler", () => ({ startScheduler: () => {} }));
vi.mock("@/lib/providers", async (original) => ({
  ...await original<typeof import("@/lib/providers")>(),
  getProvider: () => ({ name: "mock", streamInvoke: model,
    chat: async () => ({ stream: (async function* () { yield "Background outcome inspected."; })() }) }),
}));
vi.mock("@/lib/lifecycle/system-signals", async (original) => ({
  ...await original<typeof import("./system-signals")>(), requestSystemSignalDispatch: () => {},
}));
const { getDb, closeDb } = await import("@/lib/db");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { createThread, getMessages, addMessage } = await import("@/lib/stores/threads");
const signals = await import("@/lib/stores/system-signals");
const asyncResults = await import("@/lib/tools/support/async-results");
const { wrapWithWallclock } = await import("@/lib/tools/support/wallclock");
const { toolResultGetTool } = await import("@/lib/tools/support/async-results-tool");
const { invokeToolTool } = await import("@/lib/tools/system/invoke-tool");
const { dispatchSystemSignalWakeups, runtimeInstanceId } = await import("./system-signals");
const { subscribe } = await import("@/lib/notifications/bus");
const jobs = await import("@/lib/tools/delegation/claude-delegate-jobs");

afterAll(() => { asyncResults.__resetStore(); jobs._resetDelegateJobs(); closeDb(); try { rmSync(root, { recursive: true, force: true }); } catch {} });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(() => {
  asyncResults.__resetStore(); jobs._resetDelegateJobs(); model.mockReset();
  getDb().exec("DELETE FROM signal_deliveries; DELETE FROM signal_events; DELETE FROM runtime_operations; DELETE FROM messages; DELETE FROM threads;");
  model.mockImplementation(async function* () { yield { type: "text", delta: "Background outcome inspected." }; yield { type: "stop", reason: "stop" }; });
});
function owner(id: string) {
  upsertAgentConfig({ id, name: "Synthetic Contract Agent", identity: "test", instructions: "Report outcomes.", tools: ["restart_server"], model_config_name: "contract-model" });
  upsertModelConfig("contract-model", "mock", "mock", {}, true);
  return createThread(id);
}
async function output(threadId: string, text: string) {
  const target = wrapWithWallclock(tool(async () => text, { name: "contract_output", description: "Synthetic output", schema: z.object({}) }));
  const result = JSON.parse(await target.invoke({ async_run: true }, { configurable: { thread_id: threadId } }) as string);
  await vi.waitFor(() => expect(asyncResults.getAsyncResult(result.key, threadId)?.status).toBe("done"));
  return result.key as string;
}

describe("system signal full-flow contract", () => {
  it.each([16 * 1024, 1024])("reserves the proxy envelope within the %i-byte protected-page budget", async (budget) => {
    vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", String(budget));
    const thread = owner(`contract-proxy-budget-${budget}`);
    const key = await output(thread.thread_id, "S".repeat(20000));
    const { backgroundResultReference, readBackgroundResultReference } = await import("@/lib/stores/background-results");
    const name = backgroundResultReference(key);
    const probe = readBackgroundResultReference(name, thread.thread_id, 0, 1000);
    const overhead = Buffer.byteLength(JSON.stringify(probe)) - 1000;
    const response = JSON.parse(await wrapWithWallclock(invokeToolTool).invoke({ name: "tool_result_get", args: {
      result_ref: { name }, limit: budget - overhead - 8,
    } }, { configurable: { thread_id: thread.thread_id, signal_continuation: true } }) as string);
    expect(response.status).toBe("done");
    expect(response.result.source_status).toBe("done");
    expect(response.result.result.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(budget);
    expect(readdirSync(join(root, "files"))).toEqual([]);
  });

  it.each(["done", "error"] as const)("protects JSON-expanded %s output and defers consume until the final page", async (status) => {
    const thread = owner(`contract-escaped-${status}`);
    const tracked = asyncResults.startOwnedAsyncCall("synthetic_escaped", thread.thread_id);
    const text = "\u0000".repeat(4000);
    if (status === "done") asyncResults.completeAsyncCall(tracked.key, text);
    else asyncResults.failAsyncCall(tracked.key, text);
    const { executeTool } = await import("@/lib/tools/runtime/runtime");
    const envelope = await executeTool("tool_result_get", { key: tracked.key, consume: true }, { thread_id: thread.thread_id }) as { status: string; result_ref: { name: string } };
    expect(envelope.status).toBe(status);
    expect(envelope.result_ref.name).toMatch(/^background-result:/);
    expect(asyncResults.getAsyncResult(tracked.key, thread.thread_id)?.status).toBe(status);
    let offset = 0;
    let assembled = "";
    for (let index = 0; index < 10; index++) {
      const page = await executeTool("tool_result_get", { result_ref: envelope.result_ref, offset, limit: 1024 * 1024, consume: true }, { thread_id: thread.thread_id }) as { result: string; done: boolean; next_offset: number };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      assembled += page.result;
      if (page.done) break;
      offset = page.next_offset;
    }
    expect(assembled).toBe(text);
    expect(asyncResults.getAsyncResult(tracked.key, thread.thread_id)).toBeNull();
    expect(readdirSync(join(root, "files"))).toEqual([]);
  });

  it("protects large error output through the real executor and identifies it as an error", async () => {
    const thread = owner("contract-large-error");
    const tracked = asyncResults.startOwnedAsyncCall("synthetic_error", thread.thread_id);
    const text = "SYNTHETIC_PRIVATE_ERROR".repeat(2000);
    asyncResults.failAsyncCall(tracked.key, text);
    const { executeTool } = await import("@/lib/tools/runtime/runtime");
    const envelope = await executeTool("tool_result_get", { key: tracked.key }, { thread_id: thread.thread_id }) as { status: string; result_ref: { name: string } };
    expect(envelope.status).toBe("error");
    expect(envelope.result_ref.name).toMatch(/^background-result:/);
    const denied = await executeTool("tool_result_get", { result_ref: envelope.result_ref }, { thread_id: "other-thread" }) as { ok: boolean };
    expect(denied.ok).toBe(false);
    const page = await executeTool("tool_result_get", { result_ref: envelope.result_ref, limit: 1024 * 1024 }, { thread_id: thread.thread_id }) as { source_status: string; result: string };
    expect(page.source_status).toBe("error");
    expect(page.result).toContain("SYNTHETIC_PRIVATE_ERROR");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
    expect(readdirSync(join(root, "files"))).toEqual([]);
  });

  it("settles an owned result from another module instance as route bundles can do", async () => {
    const thread = owner("contract-module-reload");
    const tracked = asyncResults.startOwnedAsyncCall("synthetic_reload", thread.thread_id);
    vi.resetModules();
    const reloaded = await import("@/lib/tools/support/async-results");
    try {
      reloaded.completeAsyncCall(tracked.key, "Synthetic cross-bundle completion");
      expect(asyncResults.getAsyncResult(tracked.key, thread.thread_id)?.status).toBe("done");
      expect(signals.getSystemOperation(tracked.key)?.state).toBe("completed");
    } finally {
      reloaded.__resetStore();
      (await import("@/lib/db")).closeDb();
    }
  });

  it("retrieves completion output through the real proxy/tool loop without creating another background task", async () => {
    const thread = owner("contract-proxy-read");
    const key = await output(thread.thread_id, "Synthetic proxy-readable output");
    model.mockImplementationOnce(async function* () {
      yield { type: "tool_call_chunk", index: 0, id: "scripted-read", name: "invoke_tool",
        args_delta: JSON.stringify({ name: "tool_result_get", args: { key, async_run: true } }) };
      yield { type: "stop", reason: "tool_use" };
    });
    await dispatchSystemSignalWakeups();
    await vi.waitFor(() => expect(signals.systemSignalDiagnostics(thread.agent_id, thread.thread_id)[0].state).toBe("acknowledged"), { timeout: 3000 });
    expect(model).toHaveBeenCalledTimes(2);
    const secondMessages = model.mock.calls[1][1] as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(secondMessages.filter((message) => message.role === "tool"))).toContain("Synthetic proxy-readable output");
    expect((getDb().prepare("SELECT COUNT(*) AS count FROM runtime_operations WHERE thread_id=?").get(thread.thread_id) as { count: number }).count).toBe(1);
  });

  it("refuses a scripted model restart replay in the real LangGraph tool loop", async () => {
    const fetch = vi.fn(async () => { throw new Error("Unexpected network request in offline contract test"); });
    vi.stubGlobal("fetch", fetch);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected process exit in offline contract test"); });
    const thread = owner("contract-replay");
    addMessage(thread.thread_id, "user", "Restart Jarela now.");
    signals.beginSystemOperation({ operationId: "contract-old-restart", kind: "restart", agentId: thread.agent_id,
      threadId: thread.thread_id, originInstance: "previous-runtime" });
    signals.finishSystemOperation("contract-old-restart", "completed", "runtime.restart.completed", { restarted: true, protected_state_available: true });
    model.mockImplementationOnce(async function* () {
      yield { type: "tool_call_chunk", index: 0, id: "scripted-replay", name: "restart_server", args_delta: '{"reason":"old user instruction"}' };
      yield { type: "stop", reason: "tool_use" };
    });
    await dispatchSystemSignalWakeups();
    await vi.waitFor(() => expect(signals.systemSignalDiagnostics(thread.agent_id, thread.thread_id)[0].state).toBe("acknowledged"), { timeout: 3000 });
    expect(model).toHaveBeenCalledTimes(2);
    const count = getDb().prepare("SELECT COUNT(*) AS count FROM runtime_operations WHERE kind='restart' AND thread_id=?")
      .get(thread.thread_id) as { count: number };
    expect(count.count).toBe(1);
    const boundTools = model.mock.calls[0][3] as Array<{ function: { name: string } }>;
    expect(boundTools.map((entry) => entry.function.name)).not.toContain("restart_server");
    expect(fetch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs encrypted result to wake-up to read-only response to durable acknowledgment and UI refresh", async () => {
    const thread = owner("contract-owner");
    const key = await output(thread.thread_id, "Synthetic completed output");
    const refreshed = vi.fn();
    const unsubscribe = subscribe(refreshed);
    try {
      await dispatchSystemSignalWakeups();
      await vi.waitFor(() => expect(signals.systemSignalDiagnostics(thread.agent_id, thread.thread_id)[0].state).toBe("acknowledged"));
      await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith(expect.objectContaining({ type: "thread_message_added", thread_id: thread.thread_id, source: "system_signal" })));
      const boundTools = model.mock.calls[0][3] as Array<{ function: { name: string } }>;
      expect(boundTools.map((entry) => entry.function.name)).not.toContain("restart_server");
      const messages = model.mock.calls[0][1] as Array<{ role: string; content: unknown }>;
      expect(JSON.stringify(messages)).toContain(key);
      expect(getMessages(thread.thread_id).some((message) => message.category === "system_signal" && message.role === "assistant")).toBe(true);
      const retrieved = JSON.parse(await toolResultGetTool.invoke({ key }, { configurable: { thread_id: thread.thread_id } }) as string);
      expect(retrieved.result).toBe("Synthetic completed output");
      const blocked = JSON.parse(await invokeToolTool.invoke({ name: "restart_server", args: { reason: "old request" } },
        { configurable: { thread_id: thread.thread_id, signal_continuation: true,
          tool_permission_map: [{ name: "restart_server", permission: "disabled", permission_reason: "signal_continuation_read_only" }] } }) as string);
      expect(blocked.status).toBe("rejected");
    } finally { unsubscribe(); }
  });

  it("keeps large output owner-scoped and retrievable after the database is reopened", async () => {
    const thread = owner("contract-large");
    const peer = owner("contract-peer");
    const text = "SYNTHETIC_OWNER_ONLY".repeat(1500);
    const key = await output(thread.thread_id, text);
    asyncResults.__resetStore(); closeDb();
    const envelope = JSON.parse(await toolResultGetTool.invoke({ key }, { configurable: { thread_id: thread.thread_id } }) as string);
    expect(envelope.result_ref.name).toMatch(/^background-result:/);
    const denied = JSON.parse(await toolResultGetTool.invoke({ result_ref: envelope.result_ref }, { configurable: { thread_id: peer.thread_id } }) as string);
    expect(denied.ok).toBe(false);
    const { executeTool } = await import("@/lib/tools/runtime/runtime");
    let offset = 0;
    let assembled = "";
    for (let index = 0; index < 20; index++) {
      const page = await executeTool("tool_result_get", { result_ref: envelope.result_ref, offset, limit: 1024 * 1024 }, { thread_id: thread.thread_id }) as { result: string; done: boolean; next_offset: number };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      assembled += page.result;
      if (page.done) break;
      offset = page.next_offset;
    }
    expect(assembled).toBe(text);
    expect(readdirSync(join(root, "files"))).toEqual([]);
  });

  it("records actual Claude and Codex terminal/cancel outcomes, not launch completion", () => {
    const thread = owner("contract-delegates");
    const config = { configurable: { thread_id: thread.thread_id } };
    const claude = jobs.createJob("contract-claude", { provider: "claude", projectKey: "synthetic", sessionId: "synthetic", parentMessage: "synthetic task", resumed: false }, config);
    const codex = jobs.createJob("contract-codex", { provider: "codex", projectKey: "synthetic", sessionId: "synthetic", parentMessage: "synthetic task", resumed: false }, config);
    expect(signals.dueSystemSignalThreads()).toEqual([]);
    jobs.completeJob("contract-claude", { result: "synthetic delegate result" });
    expect(asyncResults.getAsyncResult(claude.resultKey!, thread.thread_id)?.status).toBe("done");
    expect(jobs.getJobForTool("contract-claude", "claude", "other-thread")).toBeNull();
    expect(jobs.cancelJob("contract-codex", "codex")).toBe(true);
    jobs.completeJob("contract-codex", { result: "late result must be ignored" });
    expect(asyncResults.getAsyncResult(codex.resultKey!, thread.thread_id)?.status).toBe("error");
    expect(signals.claimSystemSignals(thread.agent_id, thread.thread_id, runtimeInstanceId()).signals).toHaveLength(2);
  });
});