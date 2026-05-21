import { randomUUID } from "crypto";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "@/lib/db";

export type ScheduleKind = "once" | "cron";

export interface ScheduledTaskRow {
  id: string;
  agent_id: string;
  prompt: string;
  description: string | null;
  kind: ScheduleKind;
  schedule: string;        // ISO timestamp for "once", cron expression for "cron"
  next_run_at: string;     // ISO
  last_run_at: string | null;
  last_error: string | null;
  enabled: number;         // 0 | 1
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

export function computeNextRun(kind: ScheduleKind, schedule: string, after: Date = new Date()): Date {
  if (kind === "once") {
    const ts = new Date(schedule);
    if (Number.isNaN(ts.getTime())) throw new Error(`Invalid ISO timestamp: ${schedule}`);
    return ts;
  }
  const it = CronExpressionParser.parse(schedule, { currentDate: after });
  return it.next().toDate();
}

export function createScheduledTask(input: {
  agent_id: string;
  prompt: string;
  description?: string;
  kind: ScheduleKind;
  schedule: string;
}): ScheduledTaskRow {
  const id = randomUUID();
  const t = now();
  const next = computeNextRun(input.kind, input.schedule).toISOString();
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
       (id, agent_id, prompt, description, kind, schedule, next_run_at, last_run_at, last_error, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    )
    .run(id, input.agent_id, input.prompt, input.description ?? null, input.kind, input.schedule, next, t, t);
  return {
    id,
    agent_id: input.agent_id,
    prompt: input.prompt,
    description: input.description ?? null,
    kind: input.kind,
    schedule: input.schedule,
    next_run_at: next,
    last_run_at: null,
    last_error: null,
    enabled: 1,
    created_at: t,
    updated_at: t,
  };
}

export function listScheduledTasks(agentId?: string): ScheduledTaskRow[] {
  const db = getDb();
  const rows = agentId
    ? db.prepare("SELECT * FROM scheduled_tasks WHERE agent_id=? ORDER BY next_run_at ASC").all(agentId)
    : db.prepare("SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC").all();
  return rows as unknown as ScheduledTaskRow[];
}

export function getScheduledTask(id: string): ScheduledTaskRow | null {
  const row = getDb().prepare("SELECT * FROM scheduled_tasks WHERE id=?").get(id);
  return (row as ScheduledTaskRow | undefined) ?? null;
}

export function getDueTasks(asOf: Date = new Date()): ScheduledTaskRow[] {
  return getDb()
    .prepare("SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(asOf.toISOString()) as unknown as ScheduledTaskRow[];
}

export function deleteScheduledTask(id: string): boolean {
  const r = getDb().prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id);
  return r.changes > 0;
}

export interface UpdateScheduledTaskInput {
  prompt?: string;
  description?: string | null;
  kind?: ScheduleKind;
  schedule?: string;
  enabled?: boolean;
}

// Patch an existing task. Only the supplied fields are touched; the rest
// stay as-is. Changing `kind` or `schedule` recomputes `next_run_at`
// against the new value so the scheduler picks the right next firing.
export function updateScheduledTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRow | null {
  const existing = getScheduledTask(id);
  if (!existing) return null;
  const nextKind = patch.kind ?? existing.kind;
  const nextSchedule = patch.schedule ?? existing.schedule;
  const t = now();
  // If the schedule (kind or expression) changed, validate + recompute. If
  // it didn't change we keep the existing next_run_at so a simple prompt
  // edit doesn't accidentally re-arm an already-overdue task.
  let nextRunAt = existing.next_run_at;
  if (patch.kind !== undefined || patch.schedule !== undefined) {
    nextRunAt = computeNextRun(nextKind, nextSchedule, new Date(t)).toISOString();
  }
  getDb()
    .prepare(
      `UPDATE scheduled_tasks SET
         prompt=?, description=?, kind=?, schedule=?, next_run_at=?, enabled=?, last_error=?, updated_at=?
       WHERE id=?`,
    )
    .run(
      patch.prompt ?? existing.prompt,
      patch.description === undefined ? existing.description : patch.description,
      nextKind,
      nextSchedule,
      nextRunAt,
      patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0),
      // Clear the last error whenever the user touches the task — they've
      // presumably fixed whatever caused it.
      null,
      t,
      id,
    );
  return getScheduledTask(id);
}

export function markTaskRan(id: string, kind: ScheduleKind, schedule: string, error?: string): void {
  const t = now();
  if (kind === "once") {
    // One-shot tasks delete themselves after firing.
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id);
    return;
  }
  let nextRun: string;
  try {
    nextRun = computeNextRun(kind, schedule, new Date(t)).toISOString();
  } catch (e) {
    // Invalid cron — disable the task to avoid a tight error loop.
    getDb()
      .prepare("UPDATE scheduled_tasks SET enabled=0, last_run_at=?, last_error=?, updated_at=? WHERE id=?")
      .run(t, `Cron parse failed: ${e instanceof Error ? e.message : String(e)}`, t, id);
    return;
  }
  getDb()
    .prepare("UPDATE scheduled_tasks SET last_run_at=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?")
    .run(t, error ?? null, nextRun, t, id);
}
