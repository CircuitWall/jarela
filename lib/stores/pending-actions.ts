import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getOrCreateAgentThread } from "./threads";
import { beginSystemOperation, getSystemOperation, finishSystemOperation, emitSystemSignal, withSystemSignalTransaction } from "./system-signals";
import { runtimeInstanceId } from "@/lib/lifecycle/system-signals";

const now = () => new Date().toISOString();

export type ActionKind =
  | "install_mcp"
  | "toggle_mcp"
  | "update_agent_tools"
  | "enable_tool_category"
  | "enable_dropin_tool"
  | "update_agent"
  // Added by ADR-0010 (agent-led setup).
  | "start_oauth"
  | "set_provider_key"
  | "enable_integration"
  // Added by ADR-0036 (agent-driven harness edits).
  | "upsert_harness";

export type ActionStatus = "pending" | "approved" | "denied" | "failed";

export interface PendingActionRow {
  id: string;
  agent_id: string;
  kind: ActionKind;
  payload: string;       // JSON
  reason: string | null;
  status: ActionStatus;
  result: string | null; // JSON or error message
  created_at: string;
  decided_at: string | null;
}

export interface CreatePendingActionInput {
  agent_id: string;
  kind: ActionKind;
  payload: unknown;
  reason?: string;
}

export function createPendingAction(input: CreatePendingActionInput): PendingActionRow {
  const id = randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO pending_actions (id, agent_id, kind, payload, reason, status, result, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    )
    .run(id, input.agent_id, input.kind, JSON.stringify(input.payload), input.reason ?? null, t);
  return getPendingAction(id)!;
}

export function getPendingAction(id: string): PendingActionRow | null {
  return (getDb()
    .prepare("SELECT * FROM pending_actions WHERE id=?")
    .get(id) as unknown as PendingActionRow) ?? null;
}

export function listPendingActions(opts: { status?: ActionStatus; agent_id?: string } = {}): PendingActionRow[] {
  let sql = "SELECT * FROM pending_actions WHERE 1=1";
  const params: string[] = [];
  if (opts.status) { sql += " AND status=?"; params.push(opts.status); }
  if (opts.agent_id) { sql += " AND agent_id=?"; params.push(opts.agent_id); }
  sql += " ORDER BY created_at DESC LIMIT 200";
  return getDb().prepare(sql).all(...params) as unknown as PendingActionRow[];
}

export function reservePendingApproval(id: string): PendingActionRow | null {
  return withSystemSignalTransaction(() => {
    const action = getPendingAction(id);
    if (!action || action.status !== "pending" || getSystemOperation(`approval:${id}`)) return null;
    const thread = getOrCreateAgentThread(action.agent_id);
    beginSystemOperation({ operationId: `approval:${id}`, kind: "approval", agentId: action.agent_id,
      threadId: thread.thread_id, originInstance: runtimeInstanceId(), payload: { proposal_id: id } });
    return action;
  });
}

export function setActionStatus(
  id: string,
  status: ActionStatus,
  result: unknown,
): PendingActionRow | null {
  return withSystemSignalTransaction(() => {
    const prior = getPendingAction(id);
    if (prior && prior.status !== "pending") {
      if (prior.status === status) return prior;
      throw new Error("Approval already has a terminal outcome; do not replace it");
    }
    if (status === "denied" && getSystemOperation(`approval:${id}`)?.state === "accepted") {
      throw new Error("Approval application is already in progress; verify its outcome instead of denying it");
    }
    getDb()
      .prepare("UPDATE pending_actions SET status=?, result=?, decided_at=? WHERE id=?")
      .run(status, result === undefined ? null : JSON.stringify(result), now(), id);
    const action = getPendingAction(id);
    if (action && prior?.status !== status && status !== "pending") {
      const thread = getOrCreateAgentThread(action.agent_id);
      const kind = status === "approved" ? "approval.approved" : status === "denied" ? "approval.denied" : "approval.failed";
      if (getSystemOperation(`approval:${id}`)?.state === "accepted") {
        const unknownOutcome = result && typeof result === "object" && "outcome" in result && result.outcome === "unknown";
        finishSystemOperation(`approval:${id}`, unknownOutcome ? "outcome_unknown" : status === "failed" ? "failed" : "completed", kind,
          { proposal_id: id, status, ...(unknownOutcome ? { outcome: "unknown" } : {}) });
      } else {
        emitSystemSignal({ kind, operationId: `approval:${id}:${status}`, agentId: action.agent_id,
          threadId: thread.thread_id, originInstance: runtimeInstanceId(), payload: { proposal_id: id, status } });
      }
    }
    return action;
  });
}
