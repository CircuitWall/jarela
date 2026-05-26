import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export type ActionKind =
  | "install_mcp"
  | "toggle_mcp"
  | "update_agent_tools"
  | "update_agent"
  // Added by ADR-0010 (agent-led setup).
  | "start_oauth"
  | "set_provider_key"
  | "enable_integration";

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

export function setActionStatus(
  id: string,
  status: ActionStatus,
  result: unknown,
): PendingActionRow | null {
  getDb()
    .prepare("UPDATE pending_actions SET status=?, result=?, decided_at=? WHERE id=?")
    .run(status, result === undefined ? null : JSON.stringify(result), now(), id);
  return getPendingAction(id);
}
