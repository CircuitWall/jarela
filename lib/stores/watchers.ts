// Watcher store (ADR-0027). Sibling to lib/stores/scheduled-tasks.ts;
// shape mirrors it so the UI + trigger plumbing can treat them as
// near-equivalents apart from the diff-aware fields.
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface WatcherRow {
  id: string;
  agent_id: string;
  label: string;
  tool_name: string;
  tool_args: string;            // JSON-encoded record passed to the tool
  interval_seconds: number;
  last_fingerprint: string | null;
  last_result: string | null;   // stringified previous tool output, for the diff prompt
  last_run_at: string | null;   // ISO — most recent poll, regardless of whether it fired
  last_fired_at: string | null; // ISO — most recent firing (i.e. fingerprint changed)
  last_error: string | null;
  next_run_at: string;          // ISO
  enabled: number;              // 0 | 1
  silent: number;               // 0 | 1
  created_at: string;
  updated_at: string;
}

const MIN_INTERVAL_SECONDS = 60;
const now = () => new Date().toISOString();

export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new Error("interval_seconds must be a finite number");
  const n = Math.floor(seconds);
  if (n < MIN_INTERVAL_SECONDS) {
    throw new Error(`interval_seconds must be >= ${MIN_INTERVAL_SECONDS}`);
  }
  return n;
}

export function createWatcher(input: {
  agent_id: string;
  label: string;
  tool_name: string;
  tool_args?: Record<string, unknown>;
  interval_seconds: number;
  silent?: boolean;
}): WatcherRow {
  const id = randomUUID();
  const t = now();
  const interval = clampInterval(input.interval_seconds);
  // Schedule the very first poll for `interval` seconds from now. The
  // agent-facing tool description tells the agent to call list_watchers
  // or wait one cycle; we don't fire immediately to avoid stampedes
  // when an agent registers a watcher.
  const next = new Date(Date.now() + interval * 1000).toISOString();
  const argsJson = JSON.stringify(input.tool_args ?? {});
  const silent = input.silent ? 1 : 0;
  getDb()
    .prepare(
      `INSERT INTO watchers
       (id, agent_id, label, tool_name, tool_args, interval_seconds,
        last_fingerprint, last_result, last_run_at, last_fired_at, last_error,
        next_run_at, enabled, silent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 1, ?, ?, ?)`,
    )
    .run(id, input.agent_id, input.label, input.tool_name, argsJson, interval, next, silent, t, t);
  return {
    id,
    agent_id: input.agent_id,
    label: input.label,
    tool_name: input.tool_name,
    tool_args: argsJson,
    interval_seconds: interval,
    last_fingerprint: null,
    last_result: null,
    last_run_at: null,
    last_fired_at: null,
    last_error: null,
    next_run_at: next,
    enabled: 1,
    silent,
    created_at: t,
    updated_at: t,
  };
}

export function listWatchers(agentId?: string): WatcherRow[] {
  const db = getDb();
  const rows = agentId
    ? db.prepare("SELECT * FROM watchers WHERE agent_id=? ORDER BY next_run_at ASC").all(agentId)
    : db.prepare("SELECT * FROM watchers ORDER BY next_run_at ASC").all();
  return rows as unknown as WatcherRow[];
}

export function getWatcher(id: string): WatcherRow | null {
  const row = getDb().prepare("SELECT * FROM watchers WHERE id=?").get(id);
  return (row as WatcherRow | undefined) ?? null;
}

export function getDueWatchers(asOf: Date = new Date()): WatcherRow[] {
  return getDb()
    .prepare("SELECT * FROM watchers WHERE enabled=1 AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(asOf.toISOString()) as unknown as WatcherRow[];
}

export function deleteWatcher(id: string): boolean {
  const r = getDb().prepare("DELETE FROM watchers WHERE id=?").run(id);
  return r.changes > 0;
}

export interface UpdateWatcherInput {
  label?: string;
  interval_seconds?: number;
  enabled?: boolean;
  silent?: boolean;
}

export function updateWatcher(id: string, patch: UpdateWatcherInput): WatcherRow | null {
  const existing = getWatcher(id);
  if (!existing) return null;
  const t = now();
  const interval = patch.interval_seconds !== undefined
    ? clampInterval(patch.interval_seconds)
    : existing.interval_seconds;
  // Only recompute next_run_at when the interval changed; otherwise keep
  // the existing schedule so a label edit doesn't reset the cycle.
  const nextRunAt = patch.interval_seconds !== undefined
    ? new Date(Date.now() + interval * 1000).toISOString()
    : existing.next_run_at;
  getDb()
    .prepare(
      `UPDATE watchers
       SET label=?, interval_seconds=?, next_run_at=?, enabled=?, silent=?, updated_at=?
       WHERE id=?`,
    )
    .run(
      patch.label ?? existing.label,
      interval,
      nextRunAt,
      patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0),
      patch.silent === undefined ? existing.silent : (patch.silent ? 1 : 0),
      t,
      id,
    );
  return getWatcher(id);
}

// Bookkeeping after a poll. Always advances next_run_at. `fired`
// indicates the fingerprint changed; when false we still update
// last_run_at + last_fingerprint (first run, or unchanged).
export function recordWatcherPoll(input: {
  id: string;
  fingerprint: string;
  result: string;
  fired: boolean;
  error?: string;
}): void {
  const existing = getWatcher(input.id);
  if (!existing) return;
  const t = now();
  const nextRunAt = new Date(Date.now() + existing.interval_seconds * 1000).toISOString();
  getDb()
    .prepare(
      `UPDATE watchers
       SET last_fingerprint=?, last_result=?, last_run_at=?,
           last_fired_at=COALESCE(?, last_fired_at),
           last_error=?, next_run_at=?, updated_at=?
       WHERE id=?`,
    )
    .run(
      input.fingerprint,
      input.result,
      t,
      input.fired ? t : null,
      input.error ?? null,
      nextRunAt,
      t,
      input.id,
    );
}

export function recordWatcherPollError(id: string, error: string): void {
  const existing = getWatcher(id);
  if (!existing) return;
  const t = now();
  const nextRunAt = new Date(Date.now() + existing.interval_seconds * 1000).toISOString();
  getDb()
    .prepare(
      `UPDATE watchers SET last_run_at=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?`,
    )
    .run(t, error, nextRunAt, t, id);
}
