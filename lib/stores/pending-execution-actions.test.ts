import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingAction, getPendingAction, listPendingActions, recoverAbandonedExecutionApprovals, reservePendingApproval, setActionStatus, type ActionKind } from "./pending-actions";
import { closeDb, getDb } from "@/lib/db";
import { upsertAgentConfig } from "./agent-configs";
import { getSystemOperation } from "./system-signals";

vi.mock("@/lib/lifecycle/system-signals", async (original) => ({
  ...await original<typeof import("@/lib/lifecycle/system-signals")>(),
  requestSystemSignalDispatch: () => {},
}));

afterAll(() => closeDb());
beforeEach(() => {
  getDb().exec("DELETE FROM signal_deliveries; DELETE FROM signal_events; DELETE FROM runtime_operations; DELETE FROM pending_actions;");
  upsertAgentConfig({ id: "synthetic-execution-agent", name: "Synthetic", identity: "", instructions: "", tools: [] });
});

function action(kind: ActionKind = "ask_choice", agent_id = "synthetic-execution-agent") {
  return createPendingAction({ agent_id, kind, payload: { request_id: "synthetic" }, reason: "Synthetic approval" });
}

function events() {
  return getDb().prepare("SELECT kind, payload FROM signal_events ORDER BY seq").all();
}

describe("execution approval persistence", () => {
  it("encrypts result bytes and discards stale runnable approvals on restart", () => {
    const action = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "execute_skill", payload: { request_id: "synthetic" } });
    setActionStatus(action.id, "approved", { output: "Synthetic checked output" });
    const stored = getDb().prepare("SELECT result FROM pending_actions WHERE id=?").get(action.id);
    expect(stored?.result).toMatch(/^enc:v1:/);
    expect(stored?.result).not.toContain("Synthetic checked output");
    expect(JSON.parse(getPendingAction(action.id)!.result!)).toEqual({ output: "Synthetic checked output" });
    const authoring = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "authoring_operation", payload: { operation_id: "synthetic" } });
    setActionStatus(authoring.id, "approved", { output: "Synthetic private patch" });
    expect(getDb().prepare("SELECT result FROM pending_actions WHERE id=?").get(authoring.id)?.result).toMatch(/^enc:v1:/);
    expect(JSON.parse(getPendingAction(authoring.id)!.result!)).toEqual({ output: "Synthetic private patch" });
    const staleAuthoring = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "authoring_operation", payload: {} });
    const stale = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "execute_workflow", payload: { authorization_id: "synthetic" } });
    const ordinary = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "ask_choice", payload: {} });
    expect(recoverAbandonedExecutionApprovals()).toBe(2);
    expect(getPendingAction(stale.id)?.status).toBe("failed");
    expect(getPendingAction(staleAuthoring.id)?.status).toBe("failed");
    expect(getPendingAction(ordinary.id)?.status).toBe("pending");
    expect(recoverAbandonedExecutionApprovals()).toBe(0);
  });

  it("stores payloads and reasons and handles missing identities without creating signals", () => {
    const created = action();
    expect(created).toMatchObject({ reason: "Synthetic approval", status: "pending", result: null, decided_at: null });
    expect(JSON.parse(created.payload)).toEqual({ request_id: "synthetic" });
    expect(getPendingAction("missing")).toBeNull();
    expect(reservePendingApproval("missing")).toBeNull();
    expect(setActionStatus("missing", "failed", undefined)).toBeNull();
    expect(events()).toEqual([]);
  });

  it("filters and decrypts listed actions while retaining plain and absent results", () => {
    upsertAgentConfig({ id: "synthetic-second-agent", name: "Second", identity: "", instructions: "", tools: [] });
    const encrypted = action("execute_skill");
    setActionStatus(encrypted.id, "approved", { output: "Synthetic output" });
    const plain = action();
    setActionStatus(plain.id, "denied", "Synthetic denial");
    const pending = action("authoring_operation", "synthetic-second-agent");
    expect(listPendingActions()).toHaveLength(3);
    expect(listPendingActions({ status: "approved", agent_id: encrypted.agent_id }))
      .toEqual([getPendingAction(encrypted.id)]);
    expect(listPendingActions({ agent_id: pending.agent_id })).toEqual([pending]);
    expect(getPendingAction(plain.id)?.result).toBe(JSON.stringify("Synthetic denial"));
    expect(listPendingActions({ status: "failed" })).toEqual([]);
  });

  it("reserves only once and refuses terminal actions", () => {
    const created = action("execute_skill");
    expect(reservePendingApproval(created.id)).toEqual(created);
    expect(getSystemOperation(`approval:${created.id}`)).toMatchObject({
      kind: "approval", agent_id: created.agent_id, state: "accepted",
    });
    expect(reservePendingApproval(created.id)).toBeNull();
    const denied = action();
    setActionStatus(denied.id, "denied", undefined);
    expect(reservePendingApproval(denied.id)).toBeNull();
  });

  it.each(["approved", "denied", "failed"] as const)("publishes %s once and makes terminal outcomes immutable", (status) => {
    const created = action();
    const settled = setActionStatus(created.id, status, { result: "Synthetic result" });
    expect(settled?.decided_at).not.toBeNull();
    expect(events()).toHaveLength(1);
    expect(events()[0].kind).toBe(`approval.${status}`);
    expect(setActionStatus(created.id, status, { result: "Replacement" })).toEqual(settled);
    expect(events()).toHaveLength(1);
    for (const conflicting of ["pending", "approved", "denied", "failed"] as const) {
      if (conflicting !== status) {
        expect(() => setActionStatus(created.id, conflicting, null)).toThrow(/terminal outcome/);
      }
    }
    expect(getPendingAction(created.id)).toEqual(settled);
  });

  it("rejects denial during reserved execution without altering the action or operation", () => {
    const created = action("execute_workflow");
    reservePendingApproval(created.id);
    expect(() => setActionStatus(created.id, "denied", {})).toThrow(/already in progress/);
    expect(getPendingAction(created.id)).toEqual(created);
    expect(getSystemOperation(`approval:${created.id}`)?.state).toBe("accepted");
    expect(events()).toEqual([]);
  });

  it.each([
    { status: "approved" as const, result: { output: "Synthetic" }, state: "completed" },
    { status: "failed" as const, result: { error: "Synthetic failure" }, state: "failed" },
    { status: "failed" as const, result: { outcome: "unknown" }, state: "outcome_unknown" },
    { status: "approved" as const, result: null, state: "completed" },
  ])("settles reserved execution as $state for $status", ({ status, result, state }) => {
    const created = action("execute_skill");
    reservePendingApproval(created.id);
    setActionStatus(created.id, status, result);
    expect(getSystemOperation(`approval:${created.id}`)?.state).toBe(state);
    expect(events()).toHaveLength(1);
    expect(JSON.parse(String(events()[0].payload))).toMatchObject({ proposal_id: created.id, status });
    expect(JSON.parse(getPendingAction(created.id)!.result!)).toEqual(result);
  });

  it("retains undefined results and pending updates without publishing a terminal signal", () => {
    const created = action("authoring_operation");
    expect(setActionStatus(created.id, "pending", undefined)?.result).toBeNull();
    expect(events()).toEqual([]);
    expect(setActionStatus(created.id, "failed", undefined)?.result).toBeNull();
    expect(events()).toHaveLength(1);
  });

  it("recovers reserved execution as unknown and unreserved authorization as discarded, exactly once", () => {
    const running = action("execute_workflow");
    reservePendingApproval(running.id);
    const waiting = action("execute_skill");
    const ordinary = action();
    expect(recoverAbandonedExecutionApprovals()).toBe(2);
    expect(JSON.parse(getPendingAction(running.id)!.result!)).toMatchObject({
      outcome: "unknown", error: expect.stringContaining("verify external effects"),
    });
    expect(getSystemOperation(`approval:${running.id}`)?.state).toBe("outcome_unknown");
    expect(JSON.parse(getPendingAction(waiting.id)!.result!)).toEqual({
      error: expect.stringContaining("Request fresh approval"),
    });
    expect(getPendingAction(ordinary.id)?.status).toBe("pending");
    expect(recoverAbandonedExecutionApprovals()).toBe(0);
    expect(events()).toHaveLength(2);
  });

  it("rolls back action and operation settlement when durable signal publication fails", () => {
    const created = action("execute_skill");
    reservePendingApproval(created.id);
    getDb().exec("CREATE TEMP TRIGGER reject_approval_event BEFORE INSERT ON signal_events BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;");
    try {
      expect(() => setActionStatus(created.id, "approved", { output: "Synthetic" }))
        .toThrow(/synthetic publication failure/);
      expect(getPendingAction(created.id)).toEqual(created);
      expect(getSystemOperation(`approval:${created.id}`)?.state).toBe("accepted");
      expect(events()).toEqual([]);
    } finally {
      getDb().exec("DROP TRIGGER reject_approval_event;");
    }
    expect(setActionStatus(created.id, "approved", { output: "Synthetic" })?.status).toBe("approved");
    expect(events()).toHaveLength(1);
  });
});
