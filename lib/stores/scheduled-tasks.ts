import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "@/lib/db";
import {
  resolveReaction,
  validateReactionScript,
  normaliseReactionScriptArgs,
  type ReactionKind,
  type ResolvedReaction,
} from "./reaction-shared";

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
  // When 1 the scheduler wraps the prompt with a "reply only if material"
  // directive and a NO_REPLY sentinel; NO_REPLY/empty assistant turns are
  // dropped. Visibility is handled at the UI layer via the chat-panel
  // category-filter toolbar (firings are tagged `scheduled_task`).
  silent: number;          // 0 | 1
  // ADR-0032 — discriminated reaction. 'agent_prompt' (default) runs the
  // agent with `prompt`; 'script' runs a registered reaction.* script
  // with no LLM round-trip. The other branch's columns are forced NULL
  // by the store layer (see resolveReaction in reaction-shared.ts).
  reaction_kind: ReactionKind;
  reaction_script: string | null;
  reaction_script_args: string | null; // JSON-encoded record
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

export interface CreateScheduledTaskInput {
  agent_id: string;
  // Required for kind='agent_prompt'; ignored (stored as "") for kind='script'.
  prompt?: string;
  description?: string;
  kind: ScheduleKind;
  schedule: string;
  silent?: boolean;
  // ADR-0032 — discriminated reaction. Same shape as the watcher store.
  reaction_kind?: ReactionKind;
  reaction_script?: string | null;
  reaction_script_args?: Record<string, unknown> | null;
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTaskRow {
  const id = randomUUID();
  const t = now();
  const next = computeNextRun(input.kind, input.schedule).toISOString();
  const silent = input.silent ? 1 : 0;
  const reaction = resolveReaction({
    reaction_kind: input.reaction_kind,
    // Scheduled tasks don't carry a reaction_prompt override — the firing
    // prompt is `input.prompt` itself when kind='agent_prompt'. Pass null
    // so resolveReaction normalises it consistently.
    reaction_prompt: null,
    reaction_script: input.reaction_script,
    reaction_script_args: input.reaction_script_args,
  });
  if (reaction.kind === "agent_prompt" && !input.prompt) {
    throw new Error("prompt is required when reaction_kind='agent_prompt'");
  }
  // For kind='script' we still need a non-NULL value in the prompt column
  // (NOT NULL constraint stays). Empty string is the agreed sentinel; the
  // discriminator decides whether prompt is read.
  const prompt = reaction.kind === "script" ? (input.prompt ?? "") : input.prompt!;
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
       (id, agent_id, prompt, description, kind, schedule, next_run_at, last_run_at, last_error, enabled, silent,
        reaction_kind, reaction_script, reaction_script_args, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, input.agent_id, prompt, input.description ?? null, input.kind, input.schedule, next, silent,
      reaction.kind, reaction.script, reaction.scriptArgs, t, t,
    );
  return {
    id,
    agent_id: input.agent_id,
    prompt,
    description: input.description ?? null,
    kind: input.kind,
    schedule: input.schedule,
    next_run_at: next,
    last_run_at: null,
    last_error: null,
    enabled: 1,
    silent,
    reaction_kind: reaction.kind,
    reaction_script: reaction.script,
    reaction_script_args: reaction.scriptArgs,
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
  agent_id?: string;
  prompt?: string;
  description?: string | null;
  kind?: ScheduleKind;
  schedule?: string;
  enabled?: boolean;
  silent?: boolean;
  // ADR-0032 — same discriminated-union semantics as updateWatcher:
  // explicit reaction_kind does a full replace; absent kind allows
  // kind-preserving patch of the matching branch's fields.
  reaction_kind?: ReactionKind;
  reaction_script?: string | null;
  reaction_script_args?: Record<string, unknown> | null;
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

  // Compute the reaction columns. Two cases mirroring updateWatcher:
  //  1. patch.reaction_kind is set → fully resolve as a new reaction.
  //  2. patch.reaction_kind is absent → keep existing kind, allow the
  //     matching branch's field to be patched.
  let reaction: ResolvedReaction;
  if (patch.reaction_kind !== undefined) {
    reaction = resolveReaction({
      reaction_kind: patch.reaction_kind,
      reaction_prompt: null,
      reaction_script: patch.reaction_script,
      reaction_script_args: patch.reaction_script_args,
    });
  } else if (existing.reaction_kind === "script") {
    const script = patch.reaction_script === undefined
      ? existing.reaction_script
      : (patch.reaction_script === null ? null : validateReactionScript(patch.reaction_script));
    if (!script) {
      throw new Error(
        "reaction_script cannot be cleared while reaction_kind='script' — switch reaction_kind to 'agent_prompt' instead",
      );
    }
    const scriptArgs = patch.reaction_script_args === undefined
      ? existing.reaction_script_args
      : normaliseReactionScriptArgs(patch.reaction_script_args);
    reaction = { kind: "script", prompt: null, script, scriptArgs };
  } else {
    reaction = { kind: "agent_prompt", prompt: null, script: null, scriptArgs: null };
  }

  // Prompt column constraint: must be non-NULL. For kind='script' we keep
  // whatever was there (or "" if switching from script with empty existing).
  const nextPrompt = patch.prompt !== undefined
    ? patch.prompt
    : (reaction.kind === "agent_prompt" && existing.reaction_kind === "script"
        ? (existing.prompt || "")
        : existing.prompt);

  getDb()
    .prepare(
      `UPDATE scheduled_tasks SET
         agent_id=?, prompt=?, description=?, kind=?, schedule=?, next_run_at=?, enabled=?, silent=?, last_error=?,
         reaction_kind=?, reaction_script=?, reaction_script_args=?, updated_at=?
       WHERE id=?`,
    )
    .run(
      patch.agent_id === undefined ? existing.agent_id : patch.agent_id,
      nextPrompt,
      patch.description === undefined ? existing.description : patch.description,
      nextKind,
      nextSchedule,
      nextRunAt,
      patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0),
      patch.silent === undefined ? existing.silent : (patch.silent ? 1 : 0),
      // Clear the last error whenever the user touches the task — they've
      // presumably fixed whatever caused it.
      null,
      reaction.kind,
      reaction.script,
      reaction.scriptArgs,
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
