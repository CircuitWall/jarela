import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { withDbTransaction } from "@/lib/db/transaction";
import type { DreamKind, DreamRunStatus } from "@/api/dreaming";

// Per-agent dreaming state and the bounded dream journal (ADR-0135). State is
// deliberately separate from agent_configs: it changes on background work and
// must not invalidate agent-config caches or advertisement fingerprints.

export interface AgentDreamStateRow {
  agent_id: string;
  enabled: number;
  last_light_dream_at: string | null;
  last_light_attempt_at: string | null;
  last_light_boundary_seq: number | null;
  last_deep_dream_at: string | null;
  last_deep_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentDreamRunRow {
  id: string;
  agent_id: string;
  kind: DreamKind;
  status: DreamRunStatus;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  stats: string | null;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  error: string | null;
}

const STATE_COLUMNS = `agent_id, enabled, last_light_dream_at, last_light_attempt_at,
  last_light_boundary_seq, last_deep_dream_at, last_deep_attempt_at, last_error,
  created_at, updated_at`;

const RUN_COLUMNS = `id, agent_id, kind, status, started_at, finished_at, summary,
  stats, estimated_input_tokens, estimated_output_tokens, error`;

function now(): string {
  return new Date().toISOString();
}

export function getAgentDreamState(agentId: string): AgentDreamStateRow | null {
  return (getDb()
    .prepare(`SELECT ${STATE_COLUMNS} FROM agent_dream_state WHERE agent_id=?`)
    .get(agentId) as AgentDreamStateRow | undefined) ?? null;
}

/**
 * Create the default state row on first use. Callers validate that the agent
 * exists; the tables intentionally carry no foreign key to agent_configs
 * because that table is written with INSERT OR REPLACE, which would cascade a
 * delete on every agent edit. Orphaned rows are pruned by the dream sweep.
 */
export function getOrCreateAgentDreamState(agentId: string): AgentDreamStateRow {
  const existing = getAgentDreamState(agentId);
  if (existing) return existing;
  const t = now();
  getDb()
    .prepare(
      "INSERT INTO agent_dream_state (agent_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)",
    )
    .run(agentId, t, t);
  return getAgentDreamState(agentId)!;
}

export function listAgentDreamStates(): AgentDreamStateRow[] {
  return getDb()
    .prepare(`SELECT ${STATE_COLUMNS} FROM agent_dream_state ORDER BY agent_id ASC`)
    .all() as unknown as AgentDreamStateRow[];
}

export function setAgentDreamEnabled(agentId: string, enabled: boolean): AgentDreamStateRow {
  getOrCreateAgentDreamState(agentId);
  getDb()
    .prepare("UPDATE agent_dream_state SET enabled=?, updated_at=? WHERE agent_id=?")
    .run(enabled ? 1 : 0, now(), agentId);
  return getAgentDreamState(agentId)!;
}

export function markLightDreamAttempt(agentId: string, at: string = now()): void {
  getOrCreateAgentDreamState(agentId);
  getDb()
    .prepare("UPDATE agent_dream_state SET last_light_attempt_at=?, updated_at=? WHERE agent_id=?")
    .run(at, at, agentId);
}

export function markLightDream(agentId: string, boundarySeq: number | null, at: string = now()): void {
  getOrCreateAgentDreamState(agentId);
  getDb()
    .prepare(
      `UPDATE agent_dream_state
       SET last_light_dream_at=?, last_light_attempt_at=?, last_light_boundary_seq=?,
           last_error=NULL, updated_at=?
       WHERE agent_id=?`,
    )
    .run(at, at, boundarySeq, at, agentId);
}

export function markDeepDreamAttempt(agentId: string, at: string = now()): void {
  getOrCreateAgentDreamState(agentId);
  getDb()
    .prepare("UPDATE agent_dream_state SET last_deep_attempt_at=?, updated_at=? WHERE agent_id=?")
    .run(at, at, agentId);
}

export function markDeepDream(agentId: string, at: string = now()): void {
  getOrCreateAgentDreamState(agentId);
  getDb()
    .prepare(
      `UPDATE agent_dream_state
       SET last_deep_dream_at=?, last_deep_attempt_at=?, last_error=NULL, updated_at=?
       WHERE agent_id=?`,
    )
    .run(at, at, at, agentId);
}

export function markDreamError(agentId: string, error: string): void {
  getOrCreateAgentDreamState(agentId);
  getDb()
    .prepare("UPDATE agent_dream_state SET last_error=?, updated_at=? WHERE agent_id=?")
    .run(error.slice(0, 2_000), now(), agentId);
}

export interface CreateDreamRunInput {
  agent_id: string;
  kind: DreamKind;
  started_at?: string;
}

export function createDreamRun(input: CreateDreamRunInput): AgentDreamRunRow {
  const id = randomUUID();
  const startedAt = input.started_at ?? now();
  getDb()
    .prepare(
      `INSERT INTO agent_dream_runs
       (id, agent_id, kind, status, started_at, estimated_input_tokens, estimated_output_tokens)
       VALUES (?, ?, ?, 'running', ?, 0, 0)`,
    )
    .run(id, input.agent_id, input.kind, startedAt);
  return getDreamRun(id)!;
}

export function getDreamRun(id: string): AgentDreamRunRow | null {
  return (getDb()
    .prepare(`SELECT ${RUN_COLUMNS} FROM agent_dream_runs WHERE id=?`)
    .get(id) as AgentDreamRunRow | undefined) ?? null;
}

export interface FinishDreamRunInput {
  status: Exclude<DreamRunStatus, "running">;
  summary?: string | null;
  stats?: unknown;
  estimated_input_tokens?: number;
  estimated_output_tokens?: number;
  error?: string | null;
}

export function finishDreamRun(id: string, input: FinishDreamRunInput): AgentDreamRunRow | null {
  const serialized = input.stats === undefined || input.stats === null
    ? null
    : JSON.stringify(input.stats);
  // Bound the column without producing a truncated, unparseable JSON string.
  const stats = serialized && serialized.length > 64 * 1024
    ? JSON.stringify({ truncated: true, bytes: serialized.length })
    : serialized;
  getDb()
    .prepare(
      `UPDATE agent_dream_runs
       SET status=?, finished_at=?, summary=?, stats=?, estimated_input_tokens=?,
           estimated_output_tokens=?, error=?
       WHERE id=?`,
    )
    .run(
      input.status,
      now(),
      input.summary?.slice(0, 4_000) ?? null,
      stats,
      Math.max(0, Math.floor(input.estimated_input_tokens ?? 0)),
      Math.max(0, Math.floor(input.estimated_output_tokens ?? 0)),
      input.error?.slice(0, 2_000) ?? null,
      id,
    );
  return getDreamRun(id);
}

export interface ListDreamRunsOptions {
  agentId?: string;
  limit?: number;
}

export function listDreamRuns(options: ListDreamRunsOptions = {}): AgentDreamRunRow[] {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 20), 100));
  if (options.agentId) {
    return getDb()
      .prepare(`SELECT ${RUN_COLUMNS} FROM agent_dream_runs WHERE agent_id=? ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(options.agentId, limit) as unknown as AgentDreamRunRow[];
  }
  return getDb()
    .prepare(`SELECT ${RUN_COLUMNS} FROM agent_dream_runs ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as unknown as AgentDreamRunRow[];
}

export function listRunningDreamRuns(): AgentDreamRunRow[] {
  return getDb()
    .prepare(`SELECT ${RUN_COLUMNS} FROM agent_dream_runs WHERE status='running' ORDER BY started_at ASC`)
    .all() as unknown as AgentDreamRunRow[];
}

/**
 * A process exit can leave a `running` row behind. Anything older than the
 * caller's deadline is dead: mark it failed so the journal and the scheduler
 * lock cannot disagree forever.
 */
export function failInterruptedDreamRuns(olderThanISO: string): number {
  const result = getDb()
    .prepare(
      `UPDATE agent_dream_runs
       SET status='failed', finished_at=?, error=?, summary=NULL
       WHERE status='running' AND started_at < ?`,
    )
    .run(now(), "Interrupted before completion", olderThanISO);
  return Number(result.changes);
}

/**
 * All started attempts, including failures. The daily light budget must count
 * failed attempts too, otherwise a provider outage can retry all day.
 */
export function countDreamRunsSince(agentId: string, kind: DreamKind, sinceISO: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM agent_dream_runs
       WHERE agent_id=? AND kind=? AND started_at >= ?`,
    )
    .get(agentId, kind, sinceISO) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Failed attempts in the current idle window; used to stop retry storms. */
export function countFailedDreamRunsSince(agentId: string, kind: DreamKind, sinceISO: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM agent_dream_runs
       WHERE agent_id=? AND kind=? AND started_at >= ? AND status='failed'`,
    )
    .get(agentId, kind, sinceISO) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function sumDreamTokensSince(agentId: string, kind: DreamKind, sinceISO: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(estimated_input_tokens + estimated_output_tokens), 0) AS tokens
       FROM agent_dream_runs
       WHERE agent_id=? AND kind=? AND started_at >= ?`,
    )
    .get(agentId, kind, sinceISO) as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

export interface PruneDreamRunsOptions {
  keepPerAgent?: number;
  retentionDays?: number;
  now?: Date;
}

/** Bounded growth for the journal: age first, then a per-agent row cap. */
export function pruneDreamRuns(options: PruneDreamRunsOptions = {}): number {
  const keepPerAgent = Math.max(10, Math.min(Math.floor(options.keepPerAgent ?? 200), 5_000));
  const retentionDays = Math.max(1, Math.min(Math.floor(options.retentionDays ?? 90), 3_650));
  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 86_400_000).toISOString();
  return withDbTransaction(() => {
    const aged = getDb()
      .prepare("DELETE FROM agent_dream_runs WHERE started_at < ?")
      .run(cutoff);
    const overCap = getDb()
      .prepare(
        `DELETE FROM agent_dream_runs WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY agent_id ORDER BY started_at DESC, id DESC
             ) AS row_number
             FROM agent_dream_runs
           ) WHERE row_number > ?
         )`,
      )
      .run(keepPerAgent);
    return Number(aged.changes) + Number(overCap.changes);
  });
}

/**
 * Remove state and journal rows whose agent no longer exists. This is the
 * referential-integrity replacement for a cascading FK (see the store header).
 */
export function pruneOrphanedDreamRows(): number {
  return withDbTransaction(() => {
    const runs = getDb()
      .prepare("DELETE FROM agent_dream_runs WHERE agent_id NOT IN (SELECT id FROM agent_configs)")
      .run();
    const states = getDb()
      .prepare("DELETE FROM agent_dream_state WHERE agent_id NOT IN (SELECT id FROM agent_configs)")
      .run();
    return Number(runs.changes) + Number(states.changes);
  });
}

export function parseDreamRunStats(row: Pick<AgentDreamRunRow, "stats">): Record<string, unknown> | null {
  if (!row.stats) return null;
  try {
    const parsed = JSON.parse(row.stats) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Local-day start, used for the per-agent light-dream run/token budgets. */
export function startOfLocalDay(now: Date = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

/** Test seam. Never called from production code. */
export function __resetAgentDreamsForTests(): void {
  getDb().prepare("DELETE FROM agent_dream_runs").run();
  getDb().prepare("DELETE FROM agent_dream_state").run();
}
