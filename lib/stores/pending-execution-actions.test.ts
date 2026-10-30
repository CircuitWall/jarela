import { afterAll, describe, expect, it } from "vitest";
import { createPendingAction, getPendingAction, recoverAbandonedExecutionApprovals, setActionStatus } from "./pending-actions";
import { closeDb, getDb } from "@/lib/db";
import { upsertAgentConfig } from "./agent-configs";

afterAll(() => closeDb());
describe("execution approval persistence", () => {
  it("encrypts result bytes and discards stale runnable approvals on restart", () => {
    upsertAgentConfig({ id: "synthetic-execution-agent", name: "Synthetic", identity: "", instructions: "", tools: [] });
    const action = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "execute_skill", payload: { request_id: "synthetic" } });
    setActionStatus(action.id, "approved", { output: "Synthetic checked output" });
    const stored = getDb().prepare("SELECT result FROM pending_actions WHERE id=?").get(action.id);
    expect(stored?.result).toMatch(/^enc:v1:/);
    expect(stored?.result).not.toContain("Synthetic checked output");
    expect(JSON.parse(getPendingAction(action.id)!.result!)).toEqual({ output: "Synthetic checked output" });
    const stale = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "execute_workflow", payload: { authorization_id: "synthetic" } });
    const ordinary = createPendingAction({ agent_id: "synthetic-execution-agent", kind: "ask_choice", payload: {} });
    expect(recoverAbandonedExecutionApprovals()).toBeGreaterThanOrEqual(1);
    expect(getPendingAction(stale.id)?.status).toBe("failed");
    expect(getPendingAction(ordinary.id)?.status).toBe("pending");
    expect(recoverAbandonedExecutionApprovals()).toBe(0);
  });
});
