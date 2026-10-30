import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableWorkflowRunStore } from "@/lib/stores/workflow-runs";
import { attestWorkflowOwnerDead, WorkflowService, type WorkflowHostAdapter, type WorkflowOwner } from "./service";

vi.mock("@/lib/crypto/master-key", () => ({ getMasterKey: () => Buffer.alloc(32, 9) }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("./authorization", () => ({ requestWorkflowAuthorization: vi.fn(), revokeWorkflowAuthorizations: vi.fn() }));
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
const objectSchema = { type: "object", properties: {}, additionalProperties: true };
const step = {
  id: "first", kind: "tool", action: "read", effect: "read", input: { from: "literal", value: {} },
  inputSchema: objectSchema, outputSchema: objectSchema, maxAttempts: 2, timeoutMs: 1000,
};
const choice = {
  ...step, id: "question", kind: "choice", maxAttempts: 1,
  outputSchema: { type: "object", properties: { decision: { type: "string", enum: ["keep", "remove"] } }, required: ["decision"], additionalProperties: false },
};
const definition = (steps: unknown[] = [step]) => JSON.stringify({ schemaVersion: 1, id: "fixture", steps });
const output = { kind: "output" as const, json: '{"ok":true}', evidence: "Observed synthetic read", origin: "tool" as const };
function setup(host: WorkflowHostAdapter = { execute: async () => output }, owner?: WorkflowOwner,
  attest?: (value: WorkflowOwner) => Promise<boolean>) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE agent_configs(id TEXT PRIMARY KEY); INSERT INTO agent_configs VALUES('one'),('two')");
  const service = new WorkflowService(db, () => host, owner, attest);
  return { db, service };
}
const make = (service: WorkflowService, steps?: unknown[]) => service.create("one", definition(steps), "{}", process.cwd());

describe("production workflow service", () => {
  it("requests script-plan approval before starting a step timer and never turns a question into consent", async () => {
    const execute = vi.fn<WorkflowHostAdapter["execute"]>(async () => output);
    const prepare = vi.fn<NonNullable<WorkflowHostAdapter["prepare"]>>(async () => ({
      kind: "approval_required", proposalId: "synthetic-plan-proposal",
    }));
    const { service, db } = setup({ execute, prepare });
    const run = make(service, [{ ...step, kind: "script", maxAttempts: 1 }]);
    const pending = await service.advance("one", run.id, run.version);
    expect(pending).toMatchObject({
      phase: "ready", version: run.version,
      executionApproval: { kind: "approval_required", proposalId: "synthetic-plan-proposal" },
      steps: [{ status: "pending", attempts: 0 }],
    });
    expect(prepare.mock.calls[0][0]).toMatchObject({
      agentId: "one", runId: run.id, workspace: process.cwd(), revision: run.revision,
      version: run.version, definitionText: definition([{ ...step, kind: "script", maxAttempts: 1 }]), invocationJson: "{}",
    });
    expect(execute).not.toHaveBeenCalled();
    const withoutGrantManager = new WorkflowService(db, () => ({ execute }));
    await expect(withoutGrantManager.advance("one", run.id, run.version)).rejects.toThrow(/preflight/);
    expect(execute).not.toHaveBeenCalled();
    prepare.mockResolvedValue({ kind: "ready" });
    expect((await service.advance("one", run.id, run.version)).phase).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("passes persisted scope to trusted hosts and exposes only validated agent-owned runs", async () => {
    const execute = vi.fn<WorkflowHostAdapter["execute"]>(async () => output);
    const { service } = setup({ execute });
    const run = make(service);
    expect(() => service.inspect("two", run.id)).toThrow(/not found/);
    expect(service.list("two")).toEqual([]);
    const done = await service.advance("one", run.id, run.version);
    expect(done.phase).toBe("completed");
    expect(execute.mock.calls[0][3]).toMatchObject({
      agentId: "one", runId: run.id, workspace: process.cwd(), revision: run.revision, stepId: "first", version: 2,
    });
    expect(service.list("one")).toHaveLength(1);
    await expect(service.advance("one", run.id, run.version)).rejects.toThrow(/changed/);
    expect(() => make(service, [{ ...step, extra: true }])).toThrow();
    expect(() => service.create("one", definition(), '{"unvalidated":true}', process.cwd())).toThrow();
    expect(() => service.create("missing", definition(), "{}", process.cwd())).toThrow(/Agent not found/);
    expect(() => service.create("one", definition(), "{}", "relative")).toThrow(/workspace/);
  });

  it("restores typed choices across service restart without treating answers as execution approval", async () => {
    const execute = vi.fn<WorkflowHostAdapter["execute"]>(async () => output);
    const { service, db } = setup({ execute });
    const run = make(service, [choice, { ...step, id: "after" }]);
    const waiting = await service.advance("one", run.id, run.version);
    expect(waiting.question).toMatchObject({ stepId: "question", executionApproval: false });
    expect(execute).not.toHaveBeenCalled();
    const restarted = new WorkflowService(db, () => ({ execute }));
    await expect(restarted.answer("one", run.id, {
      version: waiting.version, revision: run.revision, stepId: "question", answerJson: '{"decision":"wrong"}',
    })).rejects.toThrow();
    const answered = await restarted.answer("one", run.id, {
      version: waiting.version, revision: run.revision, stepId: "question", answerJson: '{"decision":"keep"}',
    });
    expect(answered.phase).toBe("ready");
    expect(answered.steps[0].origin).toBe("human");
    expect(execute).not.toHaveBeenCalled();
    await expect(restarted.answer("one", run.id, {
      version: waiting.version, revision: run.revision, stepId: "question", answerJson: '{"decision":"keep"}',
    })).rejects.toThrow(/changed/);
  });

  it("requires independently verified dead ownership, recovers reads without replay, and cannot recover same-PID owners", async () => {
    const priorOwner = { pid: 123456789, instanceId: randomUUID() };
    const execute = vi.fn<WorkflowHostAdapter["execute"]>(async () => output);
    const { service, db } = setup({ execute }, priorOwner);
    const run = make(service);
    const store = new DurableWorkflowRunStore(db, "one");
    const row = store.get(run.id);
    const state = JSON.parse(row.state);
    state.phase = "running"; state.steps[0].status = "running"; state.steps[0].attempts = 1;
    const interrupted = store.save(row, JSON.stringify(state));
    const denied = new WorkflowService(db, () => ({ execute }), undefined, async () => false);
    await expect(denied.advance("one", run.id, interrupted.version)).rejects.toThrow(/verified dead/);
    const restarted = new WorkflowService(db, () => ({ execute }), undefined,
      async (value) => value.pid === priorOwner.pid && value.instanceId === priorOwner.instanceId);
    const recovered = await restarted.advance("one", run.id, interrupted.version);
    expect(recovered.phase).toBe("ready");
    expect(execute).not.toHaveBeenCalled();
    expect((await restarted.advance("one", run.id, recovered.version)).phase).toBe("completed");

    const samePid = new WorkflowService(db, () => ({ execute }), { pid: process.pid, instanceId: randomUUID() });
    const owned = make(samePid, [choice]);
    await expect(restarted.advance("one", owned.id, owned.version)).rejects.toThrow(/live or unverifiable/);
  });

  it("does not replay interrupted writes and requires host-observed reconciliation", async () => {
    const priorOwner = { pid: 123456789, instanceId: randomUUID() };
    const execute = vi.fn<WorkflowHostAdapter["execute"]>(async () => output);
    const { service, db } = setup({ execute }, priorOwner);
    const run = make(service, [{ ...step, effect: "write", maxAttempts: 1, reconcileAction: "read_back" }]);
    const store = new DurableWorkflowRunStore(db, "one");
    const row = store.get(run.id);
    const state = JSON.parse(row.state);
    state.phase = "running"; state.steps[0].status = "running"; state.steps[0].attempts = 1;
    const interrupted = store.save(row, JSON.stringify(state));
    const host = { execute, observe: vi.fn(async () => ({ outputJson: '{"ok":true}', evidence: "Observed committed record" })) };
    const restarted = new WorkflowService(db, () => host, undefined,
      async (value) => value.pid === priorOwner.pid && value.instanceId === priorOwner.instanceId);
    const recovered = await restarted.advance("one", run.id, interrupted.version);
    expect(recovered.phase).toBe("uncertain");
    await expect(restarted.advance("one", run.id, recovered.version)).rejects.toThrow(/not ready/);
    expect(execute).not.toHaveBeenCalled();
    const undeclared = make(service, [{ ...step, effect: "write", maxAttempts: 1 }]);
    const undeclaredRow = store.get(undeclared.id);
    const undeclaredState = JSON.parse(undeclaredRow.state);
    undeclaredState.phase = "uncertain"; undeclaredState.steps[0].status = "uncertain"; undeclaredState.steps[0].attempts = 1;
    const uncertain = store.save(undeclaredRow, JSON.stringify(undeclaredState));
    await expect(restarted.reconcile("one", undeclared.id, uncertain.version)).rejects.toThrow(/no reconcile read-back/);
    expect(host.observe).not.toHaveBeenCalled();
    const done = await restarted.reconcile("one", run.id, recovered.version);
    expect(done.phase).toBe("completed");
    expect(host.observe).toHaveBeenCalledOnce();
    await expect(restarted.reconcile("one", run.id, recovered.version)).rejects.toThrow(/changed/);
  });

  it("cancels a running adapter promptly and does not overwrite cancellation with late output", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: typeof output) => void;
    const { service } = setup({ execute: async () => {
      started();
      return new Promise<typeof output>((resolve) => { finish = resolve; });
    } });
    const run = make(service);
    const advancing = service.advance("one", run.id, run.version);
    await ready;
    const running = service.inspect("one", run.id);
    const cancelled = await service.cancel("one", run.id, running.version);
    expect(cancelled.phase).toBe("cancelled");
    expect((await advancing).phase).toBe("cancelled");
    finish(output);
    await Promise.resolve();
    expect(service.inspect("one", run.id).phase).toBe("cancelled");
  });

  it("lets a started adapter finish but refuses its result after the owning agent is deleted", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: typeof output) => void;
    const { service, db } = setup({ execute: async () => {
      started();
      return new Promise<typeof output>((resolve) => { finish = resolve; });
    } });
    const run = make(service);
    const advancing = service.advance("one", run.id, run.version);
    await ready;
    db.exec("DELETE FROM agent_configs WHERE id='one'");
    finish(output);
    await expect(advancing).rejects.toThrow(/not found/);
    db.exec("INSERT INTO agent_configs VALUES('one')");
    expect(service.list("one")).toEqual([]);
    expect(() => service.inspect("one", run.id)).toThrow(/not found/);
  });

  it.each([["cancel", false], ["cancel", true], ["timeout", false], ["timeout", true]] as const)(
    "blocks reconciliation of a %s write until its non-abortable adapter settles (reject=%s)", async (interruption, rejects) => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: typeof output) => void;
    let fail!: (error: Error) => void;
    const observe = vi.fn(async () => ({ outputJson: '{"ok":true}', evidence: "Observed settled write" }));
    const execute = vi.fn<WorkflowHostAdapter["execute"]>(async () => {
      started();
      return new Promise<typeof output>((resolve, reject) => { finish = resolve; fail = reject; });
    });
    const { service, db } = setup({ execute, observe });
    const sibling = new WorkflowService(db, () => ({ execute, observe }));
    const run = make(service, [{ ...step, effect: "write", maxAttempts: 1, reconcileAction: "read_back" },
      { ...step, id: "after" }]);
    const advancing = service.advance("one", run.id, run.version);
    await ready;
    const running = service.inspect("one", run.id);
    await expect(sibling.advance("one", run.id, running.version)).rejects.toThrow(/still in flight/);
    if (interruption === "cancel") {
      await sibling.cancel("one", run.id, running.version);
    } else await vi.advanceTimersByTimeAsync(1000);
    const uncertain = await advancing;
    expect(uncertain.phase).toBe("uncertain");
    for (const reader of [service, sibling]) {
      await expect(reader.reconcile("one", run.id, uncertain.version)).rejects.toThrow(/still in flight/);
      await expect(reader.advance("one", run.id, uncertain.version)).rejects.toThrow();
    }
    expect(observe).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    if (rejects) fail(new Error("Late external write failure"));
    else finish(output);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.inspect("one", run.id)).toMatchObject({ phase: "uncertain", version: uncertain.version });
    const reconciled = await sibling.reconcile("one", run.id, uncertain.version);
    expect(reconciled.phase).toBe("ready");
    expect(observe).toHaveBeenCalledOnce();
    execute.mockResolvedValue(output);
    expect((await sibling.advance("one", run.id, reconciled.version)).phase).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports shutdown undrained while an interrupted host promise is unresolved", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let reject!: (error: Error) => void;
    const { service } = setup({ execute: async () => {
      started();
      return new Promise((_, fail) => { reject = fail; });
    } });
    const run = make(service, [{ ...step, effect: "write", maxAttempts: 1 }]);
    const advancing = service.advance("one", run.id, run.version);
    await ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect((await advancing).phase).toBe("uncertain");
    const stopping = service.shutdown(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await stopping).toMatchObject({ drained: false });
    reject(new Error("Late external write failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.shutdown(0)).toMatchObject({ drained: true });
    expect(service.inspect("one", run.id).phase).toBe("uncertain");
  });

  it("revokes plan authority after terminal persistence and cancellation, but not while waiting", async () => {
    const revoke = vi.fn<(runId: string) => void>();
    const db = new DatabaseSync(":memory:"); databases.push(db);
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE agent_configs(id TEXT PRIMARY KEY); INSERT INTO agent_configs VALUES('one')");
    const store = () => new DurableWorkflowRunStore(db, "one");
    const service = new WorkflowService(db, () => ({ execute: async (_step, _input, _signal, context) => {
      expect(revoke).not.toHaveBeenCalledWith(context.runId);
      return output;
    } }), undefined, undefined, (runId) => {
      expect(JSON.parse(store().get(runId).state).phase).toMatch(/completed|failed|cancelled|uncertain/);
      revoke(runId);
    });
    const completed = make(service);
    await service.advance("one", completed.id, completed.version);
    expect(revoke).toHaveBeenLastCalledWith(completed.id);
    const waiting = make(service, [choice, { ...step, id: "after" }]);
    const asked = await service.advance("one", waiting.id, waiting.version);
    expect(revoke).not.toHaveBeenCalledWith(waiting.id);
    await service.cancel("one", waiting.id, asked.version);
    expect(revoke).toHaveBeenLastCalledWith(waiting.id);
    const failing = new WorkflowService(db, () => ({ execute: async () => ({ kind: "denied" as const }) }), undefined, undefined, revoke);
    const failed = make(failing);
    expect((await failing.advance("one", failed.id, failed.version)).phase).toBe("failed");
    expect(revoke).toHaveBeenLastCalledWith(failed.id);
    const write = make(service, [{ ...step, effect: "write", maxAttempts: 1, reconcileAction: "read_back" }]);
    const row = store().get(write.id);
    const state = JSON.parse(row.state);
    state.phase = "uncertain"; state.steps[0].status = "uncertain"; state.steps[0].attempts = 1;
    const uncertain = store().save(row, JSON.stringify(state));
    revoke.mockClear();
    const observing = new WorkflowService(db, () => ({ execute: async () => output,
      observe: async () => ({ outputJson: '{"ok":true}', evidence: "Observed read-back" }) }), undefined, undefined, revoke);
    expect((await observing.reconcile("one", write.id, uncertain.version)).phase).toBe("completed");
    expect(revoke).toHaveBeenCalledWith(write.id);
  });

  it("drains in-flight adapters on shutdown and refuses new lifecycle mutations", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { service } = setup({ execute: async (_step, _input, signal) => {
      started();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const run = make(service);
    const advancing = service.advance("one", run.id, run.version);
    await ready;
    expect(await service.shutdown(1000)).toEqual({ aborted: 1, drained: true });
    expect((await advancing).phase).toBe("cancelled");
    expect(() => make(service)).toThrow(/shutting down/);
    await expect(service.cancel("one", run.id, 3)).rejects.toThrow(/shutting down/);
  });

  it("uses a real OS dead-process observation and fails closed on live or unverifiable PIDs", async () => {
    expect(await attestWorkflowOwnerDead({ pid: process.pid, instanceId: randomUUID() })).toBe(false);
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(child.status).toBe(0);
    expect(await attestWorkflowOwnerDead({ pid: child.pid, instanceId: randomUUID() })).toBe(true);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(await attestWorkflowOwnerDead({ pid: child.pid, instanceId: randomUUID() })).toBe(false);
  });
});
