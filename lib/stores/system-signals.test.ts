import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-system-signals-"));
process.env.JARELA_DB_DIR = root;
vi.mock("@/lib/scheduler", () => ({ startScheduler: () => {} }));
vi.mock("@/lib/lifecycle/system-signals", async (original) => ({
  ...await original<typeof import("@/lib/lifecycle/system-signals")>(), requestSystemSignalDispatch: () => {},
}));
const { getDb, closeDb } = await import("@/lib/db");
const signals = await import("./system-signals");
const { persistAssistantMessage } = await import("@/lib/agents/run-thread");
const results = await import("./background-results");
const base = { kind: "configuration.applied" as const, operationId: "operation-one", agentId: "agent-one", threadId: "thread-one", originInstance: "old-instance" };
afterAll(() => { closeDb(); try { rmSync(root, { recursive: true, force: true }); } catch {} });
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  getDb().exec("DELETE FROM signal_deliveries; DELETE FROM signal_events; DELETE FROM runtime_operations; DELETE FROM threads;");
  getDb().prepare("INSERT OR IGNORE INTO agent_configs(id,name,created_at,updated_at) VALUES (?,?,?,?)")
    .run(base.agentId, "Synthetic Agent", "2026-10-06", "2026-10-06");
  getDb().prepare("INSERT INTO threads(thread_id,agent_id,created_at,updated_at) VALUES (?,?,?,?)")
    .run(base.threadId, base.agentId, "2026-10-06", "2026-10-06");
});

describe("durable signal outbox", () => {
  it("quarantines reassigned targets instead of waking another agent forever", () => {
    signals.beginSystemOperation({ ...base, kind: "restart" });
    signals.finishSystemOperation(base.operationId, "completed", "runtime.restart.completed", { restarted: true });
    const batch = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
    getDb().prepare("UPDATE threads SET agent_id=? WHERE thread_id=?").run("replacement-agent", base.threadId);
    expect(signals.acknowledgeSystemSignals(batch)).toBe(false);
    expect(signals.dueSystemSignalThreads()).toEqual([]);
    expect(signals.systemSignalDiagnostics(base.agentId, base.threadId)[0].state).toBe("dead_letter");
  });

  it("revokes a cached owned result when its durable record is deleted", async () => {
    const asyncResults = await import("@/lib/tools/support/async-results");
    const tracked = asyncResults.startOwnedAsyncCall("synthetic_revocation", base.threadId);
    asyncResults.completeAsyncCall(tracked.key, "synthetic private output");
    expect(asyncResults.getAsyncResult(tracked.key, base.threadId)?.status).toBe("done");
    results.getBackgroundResult(tracked.key, base.threadId, true);
    expect(asyncResults.getAsyncResult(tracked.key, base.threadId)).toBeNull();
    asyncResults.__resetStore();
  });

  it("pages encrypted UTF-8 output without corrupting split characters", () => {
    signals.beginSystemOperation({ ...base, kind: "background_tool" });
    results.createBackgroundResult(base.operationId, base.threadId, "synthetic_utf8");
    const text = "a\u00e9\u4e2d";
    results.finishBackgroundResult(base.operationId, "done", text, null);
    const name = results.backgroundResultReference(base.operationId);
    let offset = 0;
    let assembled = "";
    for (let index = 0; index < 10; index++) {
      const page = results.readBackgroundResultReference(name, base.threadId, offset, 1);
      assembled += page.result;
      if (page.done) break;
      offset = page.next_offset as number;
    }
    expect(assembled).toBe(text);
  });

  it("records a bounded failure receipt instead of retrying an oversized storage payload", async () => {
    const asyncResults = await import("@/lib/tools/support/async-results");
    const key = asyncResults.startAsyncCall("synthetic_huge");
    signals.beginSystemOperation({ ...base, kind: "background_tool", operationId: key });
    asyncResults.attachAsyncResultOwner(key, base.threadId);
    asyncResults.completeAsyncCall(key, "x".repeat(results.BACKGROUND_RESULT_MAX_BYTES + 1));
    expect(results.getBackgroundResult(key, base.threadId)?.status).toBe("error");
    expect(signals.getSystemOperation(key)?.state).toBe("failed");
    expect(signals.claimSystemSignals(base.agentId, base.threadId, "instance").signals[0].kind).toBe("background_tool.failed");
    asyncResults.__resetStore();
  });

  it("atomically retries result and event settlement after publication failure", async () => {
    const asyncResults = await import("@/lib/tools/support/async-results");
    const key = asyncResults.startAsyncCall("synthetic_tool");
    signals.beginSystemOperation({ ...base, kind: "background_tool", operationId: key });
    asyncResults.attachAsyncResultOwner(key, base.threadId);
    getDb().exec("CREATE TEMP TRIGGER reject_settlement_event BEFORE INSERT ON signal_events BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;");
    asyncResults.completeAsyncCall(key, "synthetic finished output");
    expect(results.getBackgroundResult(key, base.threadId)?.status).toBe("pending");
    expect(signals.getSystemOperation(key)?.state).toBe("accepted");
    getDb().exec("DROP TRIGGER reject_settlement_event;");
    vi.useFakeTimers();
    vi.advanceTimersByTime(3000);
    asyncResults.retryAsyncResultSettlements();
    expect(results.getBackgroundResult(key, base.threadId)?.status).toBe("done");
    expect(signals.getSystemOperation(key)?.state).toBe("completed");
    expect(signals.claimSystemSignals(base.agentId, base.threadId, "instance").signals).toHaveLength(1);
    asyncResults.__resetStore();
  });

  it("preserves completion context across a proxied background read", async () => {
    const asyncResults = await import("@/lib/tools/support/async-results");
    const { invokeToolTool } = await import("@/lib/tools/system/invoke-tool");
    const key = asyncResults.startAsyncCall("synthetic_tool");
    signals.beginSystemOperation({ ...base, kind: "background_tool", operationId: key });
    asyncResults.attachAsyncResultOwner(key, base.threadId);
    asyncResults.completeAsyncCall(key, "synthetic output");
    const proxied = JSON.parse(await invokeToolTool.invoke({ name: "tool_result_get", args: { key, async_run: true } },
      { configurable: { thread_id: base.threadId, signal_continuation: true,
        tool_permission_map: [{ name: "tool_result_get", permission: "disabled", permission_reason: "proxy_only" }] } }) as string);
    const handoff = typeof proxied.result === "string" ? JSON.parse(proxied.result) : proxied.result;
    expect(handoff).toMatchObject({ status: "done", result: "synthetic output" });
    expect(handoff.async).toBeUndefined();
    expect((getDb().prepare("SELECT COUNT(*) AS count FROM runtime_operations WHERE thread_id=?").get(base.threadId) as { count: number }).count).toBe(1);
    asyncResults.__resetStore();
  });

  it("keeps oversized background results encrypted and owner-scoped through paging and consume", async () => {
    const { wrapWithWallclock } = await import("@/lib/tools/support/wallclock");
    const { tool } = await import("@langchain/core/tools");
    const { z } = await import("zod");
    const { toolResultGetTool } = await import("@/lib/tools/support/async-results-tool");
    const asyncResults = await import("@/lib/tools/support/async-results");
    const output = "SYNTHETIC_PRIVATE_BACKGROUND_OUTPUT".repeat(1000);
    const wrapped = wrapWithWallclock(tool(async () => output, { name: "synthetic_large", description: "Synthetic local output", schema: z.object({}) }));
    const handoff = JSON.parse(await wrapped.invoke({ async_run: true }, { configurable: { thread_id: base.threadId } }) as string);
    await vi.waitFor(() => expect(asyncResults.getAsyncResult(handoff.key, base.threadId)?.status).toBe("done"));
    const config = { configurable: { thread_id: base.threadId } };
    const envelope = JSON.parse(await toolResultGetTool.invoke({ key: handoff.key, consume: true }, config) as string);
    expect(envelope.result_ref.name).toMatch(/^background-result:/);
    const denied = JSON.parse(await toolResultGetTool.invoke({ result_ref: envelope.result_ref }, { configurable: { thread_id: "other-thread" } }) as string);
    expect(denied.ok).toBe(false);
    let offset = 0;
    let assembled = "";
    for (let index = 0; index < 20; index++) {
      const page = JSON.parse(await toolResultGetTool.invoke({ result_ref: envelope.result_ref, offset, limit: 1024 * 1024, consume: true }, config) as string);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      assembled += page.result;
      if (page.done) break;
      offset = page.next_offset;
    }
    expect(assembled).toBe(output);
    expect(results.getBackgroundResult(handoff.key, base.threadId)).toBeNull();
    expect(asyncResults.getAsyncResult(handoff.key, base.threadId)).toBeNull();
    asyncResults.__resetStore();
  });

  it("correlates restart attempts with the last direct user request rather than automated messages", () => {
    const requestId = "00000000-0000-4000-8000-000000000001";
    getDb().prepare("INSERT INTO messages(msg_id,thread_id,role,content,created_at) VALUES (?,?, 'user', 'restart', ?)")
      .run(requestId, base.threadId, "2026-10-06");
    expect(signals.restartOperationIdForThread(base.threadId)).toBe(requestId);
    getDb().prepare("INSERT INTO messages(msg_id,thread_id,role,content,category,created_at) VALUES (?,?, 'user', 'completion', 'system_signal', ?)")
      .run("00000000-0000-4000-8000-000000000002", base.threadId, "2026-10-06");
    expect(signals.restartOperationIdForThread(base.threadId)).toBe(requestId);
  });

  it("retrieves an owned durable result through the existing tool after the memory map is cleared", async () => {
    const asyncResults = await import("@/lib/tools/support/async-results");
    const { toolResultGetTool } = await import("@/lib/tools/support/async-results-tool");
    const key = asyncResults.startAsyncCall("synthetic_tool");
    signals.beginSystemOperation({ ...base, kind: "background_tool", operationId: key });
    asyncResults.attachAsyncResultOwner(key, base.threadId);
    asyncResults.completeAsyncCall(key, "durable output");
    asyncResults.__resetStore();
    const response = JSON.parse(await toolResultGetTool.invoke({ key }, { configurable: { thread_id: base.threadId } }) as string);
    expect(response).toMatchObject({ ok: true, status: "done", result: "durable output" });
    const denied = JSON.parse(await toolResultGetTool.invoke({ key }, { configurable: { thread_id: "other-thread" } }) as string);
    expect(denied.ok).toBe(false);
  });

  it("persists encrypted background results with scoped retrieval across database reopen", () => {
    signals.beginSystemOperation({ ...base, kind: "background_tool" });
    results.createBackgroundResult(base.operationId, base.threadId, "synthetic_tool");
    results.finishBackgroundResult(base.operationId, "done", "synthetic private output", null);
    const raw = getDb().prepare("SELECT payload FROM background_tool_results WHERE key=?").get(base.operationId) as { payload: string };
    expect(raw.payload).toMatch(/^enc:v1:/);
    expect(raw.payload).not.toContain("synthetic private output");
    expect(results.getBackgroundResult(base.operationId, "other-thread")).toBeNull();
    closeDb();
    expect(results.getBackgroundResult(base.operationId, base.threadId)?.result).toBe("synthetic private output");
    expect(results.getBackgroundResult(base.operationId, base.threadId, true)?.status).toBe("done");
    expect(results.getBackgroundResult(base.operationId, base.threadId)).toBeNull();
  });

  it("validates ownership and deduplicates publication independently of delivery", () => {
    expect(() => signals.emitSystemSignal({ ...base, agentId: "other" })).toThrow("does not own");
    const first = signals.emitSystemSignal(base);
    expect(signals.emitSystemSignal(base).id).toBe(first.id);
    expect(signals.claimSystemSignals("other", base.threadId, "instance").signals).toEqual([]);
    const batch = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
    expect(batch.signals).toHaveLength(1);
    expect(signals.claimSystemSignals(base.agentId, base.threadId, "instance").signals).toEqual([]);
    expect(signals.acknowledgeSystemSignals(batch)).toBe(true);
    expect(signals.systemSignalDiagnostics(base.agentId, base.threadId)[0].state).toBe("acknowledged");
  });

  it("rolls back a domain write and publication together", () => {
    expect(() => signals.withSystemSignalTransaction(() => {
      getDb().prepare("UPDATE threads SET title=? WHERE thread_id=?").run("changed", base.threadId);
      signals.emitSystemSignal(base);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect((getDb().prepare("SELECT title FROM threads WHERE thread_id=?").get(base.threadId) as { title: string | null }).title).toBeNull();
    expect(signals.claimSystemSignals(base.agentId, base.threadId, "instance").signals).toEqual([]);
  });

  it("commits the assistant transcript and signal acknowledgment together", () => {
    signals.emitSystemSignal(base);
    const batch = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
    expect(() => signals.withSystemSignalTransaction(() => {
      persistAssistantMessage(base.threadId, "Noted.", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, batch);
      throw new Error("persistence rollback");
    })).toThrow("persistence rollback");
    expect(signals.systemSignalDiagnostics(base.agentId, base.threadId)[0].state).toBe("leased");
    persistAssistantMessage(base.threadId, "Noted.", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, batch);
    expect(signals.systemSignalDiagnostics(base.agentId, base.threadId)[0].state).toBe("acknowledged");
  });

  it("releases receipts when actual assistant persistence fails", () => {
    signals.emitSystemSignal(base);
    const batch = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
    getDb().exec("CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'synthetic transcript failure'); END;");
    expect(() => persistAssistantMessage(base.threadId, "Noted.", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, batch))
      .toThrow("synthetic transcript failure");
    getDb().exec("DROP TRIGGER reject_receipt;");
    expect(signals.systemSignalDiagnostics(base.agentId, base.threadId)[0].state).toBe("ready");
  });

  it("keeps reserved approvals recordable when the remaining outbox capacity fills", async () => {
    const { createPendingAction, reservePendingApproval, setActionStatus, getPendingAction } = await import("./pending-actions");
    const action = createPendingAction({ agent_id: base.agentId, kind: "update_agent", payload: {} });
    expect(reservePendingApproval(action.id)?.id).toBe(action.id);
    expect(reservePendingApproval(action.id)).toBeNull();
    expect(() => setActionStatus(action.id, "denied", "too late")).toThrow("already in progress");
    signals.withSystemSignalTransaction(() => {
      for (let index = 0; index < 999; index++) signals.emitSystemSignal({ ...base, operationId: `capacity-${index}` });
    });
    setActionStatus(action.id, "approved", { ok: true });
    expect(getPendingAction(action.id)?.status).toBe("approved");
    expect(signals.getSystemOperation(`approval:${action.id}`)?.state).toBe("completed");
  });

  it("does not throw or lose timeout outcomes when storage initially fails", async () => {
    const asyncResults = await import("@/lib/tools/support/async-results");
    const key = asyncResults.startAsyncCall("synthetic_timeout");
    signals.beginSystemOperation({ ...base, kind: "background_tool", operationId: key });
    asyncResults.attachAsyncResultOwner(key, base.threadId);
    getDb().exec("CREATE TEMP TRIGGER reject_timeout BEFORE UPDATE ON background_tool_results BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;");
    expect(() => asyncResults.failAsyncCall(key, "Synthetic timeout; outcome unknown", "background_tool.timed_out")).not.toThrow();
    expect(signals.getSystemOperation(key)?.state).toBe("accepted");
    getDb().exec("DROP TRIGGER reject_timeout;");
    vi.useFakeTimers();
    vi.advanceTimersByTime(3000);
    asyncResults.retryAsyncResultSettlements();
    expect(results.getBackgroundResult(key, base.threadId)?.status).toBe("error");
    expect(signals.getSystemOperation(key)?.state).toBe("outcome_unknown");
    expect(signals.claimSystemSignals(base.agentId, base.threadId, "instance").signals[0].kind).toBe("background_tool.timed_out");
    asyncResults.__resetStore();
  });

  it("fences stale acknowledgments and retries after lease expiry", () => {
    vi.useFakeTimers();
    signals.emitSystemSignal(base);
    const old = signals.claimSystemSignals(base.agentId, base.threadId, "instance", 10);
    vi.advanceTimersByTime(11);
    expect(signals.acknowledgeSystemSignals(old)).toBe(false);
    signals.claimSystemSignals(base.agentId, base.threadId, "instance", 10);
    vi.advanceTimersByTime(2000);
    const fresh = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
    expect(fresh.signals).toHaveLength(1);
    expect(signals.acknowledgeSystemSignals(old)).toBe(false);
    expect(signals.acknowledgeSystemSignals({ ...fresh, agentId: "other" })).toBe(false);
    expect(signals.acknowledgeSystemSignals(fresh)).toBe(true);
  });

  it("dead-letters repeated failures without immediate redelivery", () => {
    vi.useFakeTimers();
    signals.emitSystemSignal(base);
    for (let attempt = 0; attempt < 5; attempt++) {
      const batch = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
      expect(batch.signals).toHaveLength(1);
      signals.releaseSystemSignals(batch);
      expect(signals.claimSystemSignals(base.agentId, base.threadId, "instance").signals).toEqual([]);
      vi.advanceTimersByTime(65_000);
    }
    expect(signals.systemSignalDiagnostics(base.agentId, base.threadId)[0].state).toBe("dead_letter");
  });

  it("reconciles only accepted operations from a different instance", () => {
    signals.beginSystemOperation({ ...base, kind: "restart" });
    signals.beginSystemOperation({ ...base, kind: "background_tool", operationId: "async-one", payload: { tool: "synthetic_tool" } });
    expect(signals.reconcileSystemSignals(base.originInstance)).toBe(0);
    expect(signals.reconcileSystemSignals("new-instance")).toBe(2);
    expect(signals.reconcileSystemSignals("new-instance")).toBe(0);
    const batch = signals.claimSystemSignals(base.agentId, base.threadId, "new-instance");
    expect(batch.signals.map((signal) => signal.kind)).toEqual(["runtime.restart.completed", "runtime.background.interrupted"]);
    expect(JSON.parse(batch.signals[1].payload)).toMatchObject({ outcome: "unknown", result_available: false });
  });

  it("bounds and orders batches by journal sequence", () => {
    for (let index = 0; index < 25; index++) signals.emitSystemSignal({ ...base, operationId: `op-${index}` });
    const batch = signals.claimSystemSignals(base.agentId, base.threadId, "instance");
    expect(batch.signals).toHaveLength(20);
    expect(batch.signals.map((signal) => signal.seq)).toEqual([...batch.signals.map((signal) => signal.seq)].sort((left, right) => left - right));
    expect(() => signals.emitSystemSignal({ ...base, operationId: "too-large", payload: { text: "x".repeat(1001) } })).toThrow();
  });
});