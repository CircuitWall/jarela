import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getOrCreateAgentThread } from "./threads";
import { beginSystemOperation, getSystemOperation, finishSystemOperation, emitSystemSignal, withSystemSignalTransaction } from "./system-signals";
import { runtimeInstanceId } from "@/lib/lifecycle/system-signals";
import { decryptIfNeeded, encrypt } from "@/lib/crypto/envelope";

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
  | "upsert_harness"
  | "write_skill"
  | "ask_choice"
  | "execute_skill"
  | "execute_workflow"
  | "update_scheduled_task_prompt"
  | "update_watcher_prompt";

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
  const row = (getDb()
    .prepare("SELECT * FROM pending_actions WHERE id=?")
    .get(id) as unknown as PendingActionRow) ?? null;
  return row ? decodeAction(row) : null;
}

function decodeAction(row: PendingActionRow): PendingActionRow {
  return row.kind === "execute_skill" && row.result
    ? { ...row, result: decryptIfNeeded(row.result) } : row;
}

export function listPendingActions(opts: { status?: ActionStatus; agent_id?: string } = {}): PendingActionRow[] {
  let sql = "SELECT * FROM pending_actions WHERE 1=1";
  const params: string[] = [];
  if (opts.status) { sql += " AND status=?"; params.push(opts.status); }
  if (opts.agent_id) { sql += " AND agent_id=?"; params.push(opts.agent_id); }
  sql += " ORDER BY created_at DESC LIMIT 200";
  return (getDb().prepare(sql).all(...params) as unknown as PendingActionRow[]).map(decodeAction);
}

export function recoverAbandonedExecutionApprovals(): number {
  const rows = getDb().prepare(`SELECT id FROM pending_actions
    WHERE status='pending' AND kind IN ('execute_skill','execute_workflow')`).all();
  for (const row of rows) {
    if (typeof row.id !== "string") throw new Error("Invalid stored execution approval identity");
    const accepted = getSystemOperation(`approval:${row.id}`)?.state === "accepted";
    setActionStatus(row.id, "failed", {
      error: accepted ? "App restarted during execution; verify external effects before retrying"
        : "App restarted; execution authorization was discarded. Request fresh approval",
      ...(accepted ? { outcome: "unknown" } : {}),
    });
  }
  return rows.length;
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
    const serialized = result === undefined ? null : JSON.stringify(result);
    const stored = prior?.kind === "execute_skill" && serialized !== null ? encrypt(serialized) : serialized;
    getDb()
      .prepare("UPDATE pending_actions SET status=?, result=?, decided_at=? WHERE id=?")
      .run(status, stored, now(), id);
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
