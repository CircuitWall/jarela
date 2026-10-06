import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { interruptBackgroundResults, finishBackgroundResult, BACKGROUND_RESULT_RETENTION_MS } from "./background-results";

export const systemSignalKindSchema = z.enum([
  "runtime.restart.completed", "runtime.background.interrupted",
  "configuration.applied", "configuration.restart_required",
  "approval.approved", "approval.denied", "approval.failed",
  "background_tool.completed", "background_tool.failed", "background_tool.timed_out",
  "background_job.completed", "background_job.failed",
]);
export type SystemSignalKind = z.infer<typeof systemSignalKindSchema>;
export type SignalPayload = Record<string, string | number | boolean | null>;
const payloadSchema = z.record(z.string().max(100), z.union([
  z.string().max(1000), z.number().finite(), z.boolean(), z.null(),
])).refine((value) => JSON.stringify(value).length <= 2000, "System signal payload exceeds 2000 characters");
const operationSchema = z.object({
  operationId: z.string().min(1).max(200), kind: z.string().min(1).max(100),
  agentId: z.string().min(1).max(200), threadId: z.string().min(1).max(200),
  originInstance: z.string().min(1).max(200), payload: payloadSchema.optional(),
});
type OperationInput = z.infer<typeof operationSchema>;
interface OperationRow {
  id: string; kind: string; agent_id: string; thread_id: string; origin_instance: string;
  state: "accepted" | "completed" | "failed" | "outcome_unknown"; payload: string;
}
export interface SystemSignalRow {
  seq: number; id: string; kind: SystemSignalKind; schema_version: number;
  operation_id: string; agent_id: string; thread_id: string; payload: string; created_at: number;
}
export interface SystemSignalBatch {
  agentId: string; threadId: string; leaseToken: string; signals: SystemSignalRow[];
}
const MAX_ATTEMPTS = 5;
const MAX_BACKLOG = 1000;

export function withSystemSignalTransaction<Result>(work: () => Result): Result {
  const db = getDb();
  const savepoint = `signals_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    throw error;
  }
}

export function beginSystemOperation(input: OperationInput): string {
  const value = operationSchema.parse(input);
  const db = getDb();
  const owner = db.prepare("SELECT agent_id FROM threads WHERE thread_id=?").get(value.threadId) as { agent_id: string } | undefined;
  if (owner?.agent_id !== value.agentId) throw new Error("System signal target does not own the thread");
  const existing = db.prepare("SELECT * FROM runtime_operations WHERE id=?").get(value.operationId) as OperationRow | undefined;
  if (existing) {
    if (existing.agent_id !== value.agentId || existing.thread_id !== value.threadId || existing.kind !== value.kind) {
      throw new Error("System operation correlation belongs to a different target or kind");
    }
    return existing.id;
  }
  const count = db.prepare(`SELECT (SELECT COUNT(*) FROM runtime_operations WHERE thread_id=? AND state='accepted')
    + (SELECT COUNT(*) FROM signal_deliveries d JOIN signal_events e ON e.id=d.event_id
       WHERE e.thread_id=? AND d.state IN ('ready','leased')) AS count`)
    .get(value.threadId, value.threadId) as { count: number };
  if (count.count >= MAX_BACKLOG) throw new Error("System operation backlog limit reached");
  db.prepare(`INSERT INTO runtime_operations(id,kind,agent_id,thread_id,origin_instance,state,payload,created_at,updated_at)
    VALUES (?,?,?,?,?,'accepted',?,?,?)`)
    .run(value.operationId, value.kind, value.agentId, value.threadId, value.originInstance,
      JSON.stringify(value.payload ?? {}), Date.now(), Date.now());
  return value.operationId;
}

export function getSystemOperation(operationId: string): OperationRow | null {
  return (getDb().prepare("SELECT * FROM runtime_operations WHERE id=?").get(operationId) as OperationRow | undefined) ?? null;
}

export function restartOperationIdForThread(threadId: unknown): string | null {
  if (typeof threadId !== "string") return null;
  const row = getDb().prepare(`SELECT msg_id FROM messages WHERE thread_id=? AND role='user' AND category IS NULL
    ORDER BY rowid DESC LIMIT 1`).get(threadId) as { msg_id: string } | undefined;
  return row?.msg_id ?? null;
}

function publish(operation: OperationRow, kind: SystemSignalKind, payload: SignalPayload): SystemSignalRow {
  systemSignalKindSchema.parse(kind);
  const body = JSON.stringify(payloadSchema.parse(payload));
  const db = getDb();
  const existing = db.prepare("SELECT * FROM signal_events WHERE kind=? AND operation_id=? AND agent_id=? AND thread_id=?")
    .get(kind, operation.id, operation.agent_id, operation.thread_id) as SystemSignalRow | undefined;
  if (existing) return existing;
  const count = db.prepare(`SELECT COUNT(*) AS count FROM signal_deliveries d JOIN signal_events e ON e.id=d.event_id
    WHERE e.thread_id=? AND d.state IN ('ready','leased')`).get(operation.thread_id) as { count: number };
  if (count.count >= MAX_BACKLOG) throw new Error("System signal delivery backlog limit reached");
  const id = randomUUID();
  const timestamp = Date.now();
  db.prepare("INSERT INTO signal_events(id,kind,operation_id,agent_id,thread_id,payload,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, kind, operation.id, operation.agent_id, operation.thread_id, body, timestamp);
  const wakeEligible = operation.kind === "restart" || (operation.kind === "background_tool" && JSON.parse(operation.payload).wake_eligible !== false);
  db.prepare("INSERT INTO signal_deliveries(event_id,state,available_at,updated_at,wake_eligible) VALUES (?,'ready',?,?,?)")
    .run(id, timestamp, timestamp, wakeEligible ? 1 : 0);
  return db.prepare("SELECT * FROM signal_events WHERE id=?").get(id) as unknown as SystemSignalRow;
}

export function emitSystemSignal(input: OperationInput & { kind: SystemSignalKind }): SystemSignalRow {
  return withSystemSignalTransaction(() => {
    beginSystemOperation(input);
    const operation = getDb().prepare("SELECT * FROM runtime_operations WHERE id=?").get(input.operationId) as unknown as OperationRow;
    const event = publish(operation, input.kind, input.payload ?? {});
    getDb().prepare("UPDATE runtime_operations SET state='completed',updated_at=? WHERE id=? AND state='accepted'")
      .run(Date.now(), operation.id);
    return event;
  });
}

export function finishSystemOperation(operationId: string, state: "completed" | "failed" | "outcome_unknown", kind: SystemSignalKind, payload: SignalPayload = {}): void {
  withSystemSignalTransaction(() => {
    const db = getDb();
    const operation = db.prepare("SELECT * FROM runtime_operations WHERE id=?").get(operationId) as OperationRow | undefined;
    if (!operation || operation.state !== "accepted") return;
    publish(operation, kind, payload);
    db.prepare("UPDATE runtime_operations SET state=?,updated_at=? WHERE id=? AND state='accepted'")
      .run(state, Date.now(), operationId);
  });
}

export function finishBackgroundOperation(key: string, status: "done" | "error", result: string | null, error: string | null,
  kind: "background_tool.completed" | "background_tool.failed" | "background_tool.timed_out"): void {
  withSystemSignalTransaction(() => {
    const operation = getSystemOperation(key);
    if (!operation || operation.state !== "accepted") return;
    finishBackgroundResult(key, status, result, error);
    finishSystemOperation(key, kind === "background_tool.timed_out" ? "outcome_unknown" : status === "done" ? "completed" : "failed", kind, {
      tool: JSON.parse(operation.payload).tool ?? "unknown", result_key: key, result_available: true,
      result_durable: true, result_expires_at: Date.now() + BACKGROUND_RESULT_RETENTION_MS,
      ...(kind === "background_tool.timed_out" ? { outcome: "unknown" } : {}),
    });
  });
}

function retryDelivery(eventId: string, attempts: number, failureCode: string, now: number): void {
  const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1)) + Math.floor(Math.random() * 250);
  getDb().prepare(`UPDATE signal_deliveries SET state=?,available_at=?,lease_token=NULL,lease_instance=NULL,
    lease_until=NULL,failure_code=?,updated_at=? WHERE event_id=?`)
    .run(attempts >= MAX_ATTEMPTS ? "dead_letter" : "ready", now + delay, failureCode, now, eventId);
  if (attempts >= MAX_ATTEMPTS) console.warn("[system-signals] delivery dead-lettered", { event_id: eventId, failure_code: failureCode });
}

export function claimSystemSignals(agentId: string, threadId: string, instanceId: string, leaseMs = 30 * 60_000): SystemSignalBatch {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid signal lease duration");
  return withSystemSignalTransaction(() => {
    const db = getDb();
    quarantineChangedTargets();
    const now = Date.now();
    const expired = db.prepare(`SELECT d.event_id,d.attempts FROM signal_deliveries d JOIN signal_events e ON e.id=d.event_id
      WHERE e.agent_id=? AND e.thread_id=? AND d.state='leased' AND d.lease_until<=?`)
      .all(agentId, threadId, now) as Array<{ event_id: string; attempts: number }>;
    for (const row of expired) retryDelivery(row.event_id, row.attempts, "lease_expired", now);
    const rows = db.prepare(`SELECT e.* FROM signal_events e JOIN signal_deliveries d ON d.event_id=e.id
      JOIN threads t ON t.thread_id=e.thread_id AND t.agent_id=e.agent_id
      WHERE e.agent_id=? AND e.thread_id=? AND d.state='ready' AND d.available_at<=? ORDER BY e.seq LIMIT 20`)
      .all(agentId, threadId, now) as unknown as SystemSignalRow[];
    const batch: SystemSignalBatch = { agentId, threadId, leaseToken: randomUUID(), signals: [] };
    let chars = 0;
    for (const row of rows) {
      const length = JSON.stringify(row).length;
      if (chars + length > 8000) break;
      chars += length;
      db.prepare(`UPDATE signal_deliveries SET state='leased',attempts=attempts+1,lease_token=?,lease_instance=?,lease_until=?,updated_at=?
        WHERE event_id=? AND state='ready'`).run(batch.leaseToken, instanceId, now + leaseMs, now, row.id);
      batch.signals.push(row);
    }
    return batch;
  });
}

export function renewSystemSignalLease(batch: SystemSignalBatch, leaseMs = 30 * 60_000): void {
  const now = Date.now();
  const update = getDb().prepare("UPDATE signal_deliveries SET lease_until=?,updated_at=? WHERE event_id=? AND state='leased' AND lease_token=? AND lease_until>?");
  for (const signal of batch.signals) update.run(now + leaseMs, now, signal.id, batch.leaseToken, now);
}

export function acknowledgeSystemSignals(batch: SystemSignalBatch): boolean {
  if (!batch.signals.length) return true;
  return withSystemSignalTransaction(() => {
    const db = getDb();
    const now = Date.now();
    const count = db.prepare(`SELECT COUNT(*) AS count FROM signal_deliveries d JOIN signal_events e ON e.id=d.event_id
      JOIN threads t ON t.thread_id=e.thread_id AND t.agent_id=e.agent_id
      WHERE e.agent_id=? AND e.thread_id=? AND d.state='leased' AND d.lease_token=? AND d.lease_until>?`)
      .get(batch.agentId, batch.threadId, batch.leaseToken, now) as { count: number };
    if (count.count !== batch.signals.length) return false;
    db.prepare("UPDATE signal_deliveries SET state='acknowledged',lease_token=NULL,lease_instance=NULL,lease_until=NULL,updated_at=? WHERE lease_token=? AND state='leased'")
      .run(now, batch.leaseToken);
    pruneAcknowledgedSystemSignals();
    return true;
  });
}

export function releaseSystemSignals(batch: SystemSignalBatch, failureCode = "turn_failed"): void {
  withSystemSignalTransaction(() => {
    const rows = getDb().prepare("SELECT event_id,attempts FROM signal_deliveries WHERE lease_token=? AND state='leased'")
      .all(batch.leaseToken) as Array<{ event_id: string; attempts: number }>;
    for (const row of rows) retryDelivery(row.event_id, row.attempts, failureCode, Date.now());
  });
}

export function commitSystemSignalTranscript<Result>(batch: SystemSignalBatch, persist: () => Result): Result {
  if (!batch.signals.length) return persist();
  try {
    return withSystemSignalTransaction(() => {
      const result = persist();
      if (!acknowledgeSystemSignals(batch)) throw new Error("System signal delivery lease was lost before transcript commit");
      return result;
    });
  } catch (error) {
    try { releaseSystemSignals(batch, "transcript_commit_failed"); }
    catch { console.error("[system-signals] lease release failed after transcript error"); }
    throw error;
  }
}

export function reconcileSystemSignals(instanceId: string): number {
  const rows = getDb().prepare("SELECT * FROM runtime_operations WHERE state='accepted' AND origin_instance<>?")
    .all(instanceId) as unknown as OperationRow[];
  let completed = 0;
  for (const row of rows) {
    if (row.kind === "restart") {
      finishSystemOperation(row.id, "completed", "runtime.restart.completed", { restarted: true, protected_state_available: true });
      completed++;
    } else if (row.kind === "background_tool") {
      const result = getDb().prepare("SELECT status,expires_at FROM background_tool_results WHERE key=?").get(row.id) as { status: string; expires_at: number } | undefined;
      if (result && result.status !== "pending") {
        finishSystemOperation(row.id, result.status === "done" ? "completed" : "failed",
          result.status === "done" ? "background_tool.completed" : "background_tool.failed", {
            tool: JSON.parse(row.payload).tool ?? "unknown", result_key: row.id,
            result_durable: true, result_available: result.expires_at > Date.now(), result_expires_at: result.expires_at,
          });
      } else {
        finishSystemOperation(row.id, "outcome_unknown", "runtime.background.interrupted", {
          tool: JSON.parse(row.payload).tool ?? "unknown", outcome: "unknown", result_available: false,
        });
      }
      completed++;
    }
  }
  const approvals = rows.filter((row) => row.kind === "approval");
  for (const row of approvals) {
    const proposalId = JSON.parse(row.payload).proposal_id as string;
    withSystemSignalTransaction(() => {
      getDb().prepare("UPDATE pending_actions SET status='failed',result=?,decided_at=? WHERE id=? AND status='pending'")
        .run(JSON.stringify({ error: "Approval application interrupted; external outcome unknown. Verify before retrying." }), new Date().toISOString(), proposalId);
      finishSystemOperation(row.id, "outcome_unknown", "approval.failed", { proposal_id: proposalId, status: "failed", outcome: "unknown" });
    });
    completed++;
  }
  const leases = getDb().prepare("SELECT event_id,attempts FROM signal_deliveries WHERE state='leased' AND lease_instance<>?")
    .all(instanceId) as Array<{ event_id: string; attempts: number }>;
  for (const row of leases) retryDelivery(row.event_id, row.attempts, "instance_restarted", Date.now());
  interruptBackgroundResults(instanceId);
  pruneAcknowledgedSystemSignals();
  return completed;
}

function pruneAcknowledgedSystemSignals(): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  getDb().prepare(`DELETE FROM runtime_operations WHERE state<>'accepted' AND updated_at<?
    AND NOT EXISTS (SELECT 1 FROM signal_events e JOIN signal_deliveries d ON d.event_id=e.id
      WHERE e.operation_id=runtime_operations.id AND (d.state<>'acknowledged' OR d.updated_at>=?))`)
    .run(cutoff, cutoff);
}

export function systemSignalDiagnostics(agentId: string, threadId: string): Array<{ state: string; count: number; oldest_at: number }> {
  return getDb().prepare(`SELECT d.state,COUNT(*) AS count,MIN(e.created_at) AS oldest_at FROM signal_deliveries d
    JOIN signal_events e ON e.id=d.event_id WHERE e.agent_id=? AND e.thread_id=? GROUP BY d.state`)
    .all(agentId, threadId) as Array<{ state: string; count: number; oldest_at: number }>;
}

export function dueSystemSignalThreads(): string[] {
  quarantineChangedTargets();
  const rows = getDb().prepare(`SELECT e.thread_id,MIN(e.seq) AS first_seq FROM signal_events e JOIN signal_deliveries d ON d.event_id=e.id
    JOIN threads t ON t.thread_id=e.thread_id AND t.agent_id=e.agent_id
    WHERE d.wake_eligible=1 AND (d.state='ready' AND d.available_at<=? OR d.state='leased' AND d.lease_until<=?)
    GROUP BY e.thread_id ORDER BY first_seq LIMIT 20`).all(Date.now(), Date.now()) as Array<{ thread_id: string }>;
  return rows.map((row) => row.thread_id);
}

export function deferFailedSignalWakeup(threadId: string): void {
  withSystemSignalTransaction(() => {
    const now = Date.now();
    const rows = getDb().prepare(`SELECT d.event_id,d.attempts FROM signal_deliveries d JOIN signal_events e ON e.id=d.event_id
      WHERE e.thread_id=? AND d.wake_eligible=1 AND d.state='ready' AND d.available_at<=?`)
      .all(threadId, now) as Array<{ event_id: string; attempts: number }>;
    for (const row of rows) {
      getDb().prepare("UPDATE signal_deliveries SET attempts=attempts+1 WHERE event_id=?").run(row.event_id);
      retryDelivery(row.event_id, row.attempts + 1, "wake_preparation_failed", now);
    }
  });
}

function quarantineChangedTargets(): void {
  const rows = getDb().prepare(`SELECT d.event_id FROM signal_deliveries d JOIN signal_events e ON e.id=d.event_id
    JOIN threads t ON t.thread_id=e.thread_id WHERE t.agent_id<>e.agent_id AND d.state IN ('ready','leased') LIMIT 50`)
    .all() as Array<{ event_id: string }>;
  for (const row of rows) {
    getDb().prepare(`UPDATE signal_deliveries SET state='dead_letter',failure_code='target_changed',lease_token=NULL,
      lease_instance=NULL,lease_until=NULL,updated_at=? WHERE event_id=?`).run(Date.now(), row.event_id);
    console.warn("[system-signals] delivery quarantined after target change", { event_id: row.event_id });
  }
}