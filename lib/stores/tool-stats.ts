import type { PersistedToolEvent } from "@/lib/stores/threads";
import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface ToolStatsRow {
  tool_name: string;
  call_count: number;
  success_count: number;
  error_count: number;
  used_count: number;
  last_called_at: string | null;
  updated_at: string;
}

export interface ToolUsefulnessStats {
  call_count: number;
  success_count: number;
  error_count: number;
  used_count: number;
  success_rate: number;
  usefulness_rate: number;
  score: number;
  never_used: boolean;
  last_called_at: string | null;
}

interface ToolUsageDelta {
  name: string;
  calls: number;
  successes: number;
  errors: number;
  used: number;
}

export interface ToolFailureSampleRow {
  tool_name: string;
  normalized_reason: string;
  count: number;
  sample_error: string;
  sample_arg_shape: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface ToolFailureSampleDelta {
  name: string;
  reason: string;
  sampleError: string;
  argShape: string;
}

const FAILURE_SAMPLE_MAX_CHARS = 300;
const FAILURE_ARG_SHAPE_MAX_CHARS = 200;
const FAILURE_SAMPLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const UPSERT_SQL = `
  INSERT INTO tool_stats
    (tool_name, call_count, success_count, error_count, used_count, last_called_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tool_name) DO UPDATE SET
    call_count = tool_stats.call_count + excluded.call_count,
    success_count = tool_stats.success_count + excluded.success_count,
    error_count = tool_stats.error_count + excluded.error_count,
    used_count = tool_stats.used_count + excluded.used_count,
    last_called_at = COALESCE(excluded.last_called_at, tool_stats.last_called_at),
    updated_at = excluded.updated_at
`;

const UPSERT_FAILURE_SAMPLE_SQL = `
  INSERT INTO tool_failure_samples
    (tool_name, normalized_reason, count, sample_error, sample_arg_shape, first_seen_at, last_seen_at)
  VALUES
    (?, ?, 1, ?, ?, ?, ?)
  ON CONFLICT(tool_name, normalized_reason) DO UPDATE SET
    count = tool_failure_samples.count + 1,
    sample_error = excluded.sample_error,
    sample_arg_shape = excluded.sample_arg_shape,
    last_seen_at = excluded.last_seen_at
`;

export function recordToolUsage(
  toolEvents: readonly PersistedToolEvent[],
  assistantContent: string,
): void {
  const deltas = summarizeToolUsage(toolEvents, assistantContent);
  const failureSamples = summarizeToolFailureSamples(toolEvents);
  if (deltas.length === 0) return;

  const db = getDb();
  const stamp = now();
  const stmt = db.prepare(UPSERT_SQL);
  const failureStmt = db.prepare(UPSERT_FAILURE_SAMPLE_SQL);
  db.exec("BEGIN");
  try {
    for (const row of deltas) {
      stmt.run(
        row.name,
        row.calls,
        row.successes,
        row.errors,
        row.used,
        row.calls > 0 ? stamp : null,
        stamp,
      );
    }
    for (const sample of failureSamples) {
      failureStmt.run(
        sample.name,
        sample.reason,
        sample.sampleError,
        sample.argShape,
        stamp,
        stamp,
      );
    }
    pruneToolFailureSamples(stamp);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback failure */ }
    throw err;
  }
}

export function listToolStats(): ToolStatsRow[] {
  return getDb()
    .prepare(
      `SELECT tool_name, call_count, success_count, error_count, used_count, last_called_at, updated_at
         FROM tool_stats`,
    )
    .all() as unknown as ToolStatsRow[];
}

export function getToolStatsMap(names?: readonly string[]): Map<string, ToolUsefulnessStats> {
  const rows = names && names.length > 0
    ? getDb()
      .prepare(
        `SELECT tool_name, call_count, success_count, error_count, used_count, last_called_at, updated_at
           FROM tool_stats
          WHERE tool_name IN (${names.map(() => "?").join(",")})`,
      )
      .all(...names) as unknown as ToolStatsRow[]
    : listToolStats();

  const out = new Map<string, ToolUsefulnessStats>();
  for (const row of rows) out.set(row.tool_name, toStats(row));
  return out;
}

export function listToolFailureSamples(toolName?: string): ToolFailureSampleRow[] {
  const sql = `SELECT tool_name, normalized_reason, count, sample_error, sample_arg_shape, first_seen_at, last_seen_at
     FROM tool_failure_samples${toolName ? " WHERE tool_name=?" : ""}
     ORDER BY count DESC, last_seen_at DESC`;
  return (toolName
    ? getDb().prepare(sql).all(toolName)
    : getDb().prepare(sql).all()) as unknown as ToolFailureSampleRow[];
}

export function pruneToolFailureSamples(referenceIso = now()): number {
  const referenceMs = Date.parse(referenceIso);
  const cutoff = new Date((Number.isFinite(referenceMs) ? referenceMs : Date.now()) - FAILURE_SAMPLE_TTL_MS).toISOString();
  const result = getDb()
    .prepare("DELETE FROM tool_failure_samples WHERE last_seen_at < ?")
    .run(cutoff) as { changes: number };
  return result.changes;
}

export function defaultToolStats(): ToolUsefulnessStats {
  return {
    call_count: 0,
    success_count: 0,
    error_count: 0,
    used_count: 0,
    success_rate: 1,
    usefulness_rate: 1,
    score: 1,
    never_used: true,
    last_called_at: null,
  };
}

export function toStats(row: ToolStatsRow): ToolUsefulnessStats {
  const calls = Math.max(0, row.call_count);
  if (calls === 0) return defaultToolStats();

  const successRate = clamp01(row.success_count / calls);
  const usefulnessRate = clamp01(row.used_count / calls);
  const score = clamp01((successRate * 0.65) + (usefulnessRate * 0.35));

  return {
    call_count: calls,
    success_count: row.success_count,
    error_count: row.error_count,
    used_count: row.used_count,
    success_rate: successRate,
    usefulness_rate: usefulnessRate,
    score,
    never_used: false,
    last_called_at: row.last_called_at,
  };
}

export function summarizeToolUsage(
  toolEvents: readonly PersistedToolEvent[],
  assistantContent: string,
): ToolUsageDelta[] {
  const byId = new Map<string, { name: string; successful: boolean; used: boolean }>();
  const assistantTerms = normalizeText(assistantContent);

  for (const ev of toolEvents) {
    if (!ev.name) continue;
    const key = ev.id || `${ev.phase}:${ev.name}`;
    const existing = byId.get(key) ?? { name: ev.name, successful: false, used: false };

    if (ev.phase === "call") {
      existing.name = ev.name;
    } else if (ev.phase === "result") {
      const successful = !isErrorPayload(ev.payload);
      existing.successful = successful;
      existing.used = successful && payloadLooksUsed(ev.payload, assistantTerms);
    }

    byId.set(key, existing);
  }

  const totals = new Map<string, ToolUsageDelta>();
  for (const ev of toolEvents) {
    if (ev.phase !== "call" || !ev.name) continue;
    const key = ev.id || `${ev.phase}:${ev.name}`;
    const outcome = byId.get(key);
    const next = totals.get(ev.name) ?? {
      name: ev.name,
      calls: 0,
      successes: 0,
      errors: 0,
      used: 0,
    };
    next.calls += 1;
    if (outcome?.successful) next.successes += 1;
    else next.errors += 1;
    if (outcome?.used) next.used += 1;
    totals.set(ev.name, next);
  }

  return [...totals.values()];
}

export function summarizeToolFailureSamples(
  toolEvents: readonly PersistedToolEvent[],
): ToolFailureSampleDelta[] {
  const byId = new Map<string, { name: string; callPayload: unknown; resultPayload?: unknown }>();
  for (const ev of toolEvents) {
    if (!ev.name) continue;
    const key = ev.id || `${ev.phase}:${ev.name}`;
    const existing = byId.get(key) ?? { name: ev.name, callPayload: undefined };
    existing.name = ev.name;
    if (ev.phase === "call") existing.callPayload = ev.payload;
    else if (ev.phase === "result") existing.resultPayload = ev.payload;
    byId.set(key, existing);
  }

  const out: ToolFailureSampleDelta[] = [];
  for (const item of byId.values()) {
    if (!isErrorPayload(item.resultPayload)) continue;
    const errorText = sampleErrorText(item.resultPayload);
    out.push({
      name: item.name,
      reason: normalizeFailureReason(errorText, item.resultPayload),
      sampleError: truncateForSample(redactPotentialSecret(errorText), FAILURE_SAMPLE_MAX_CHARS),
      argShape: truncateForSample(argShape(item.callPayload), FAILURE_ARG_SHAPE_MAX_CHARS),
    });
  }
  return out;
}

function payloadLooksUsed(payload: unknown, assistantTerms: Set<string>): boolean {
  if (assistantTerms.size === 0) return false;
  const candidates = extractPayloadTerms(payload);
  if (candidates.length === 0) return false;

  let matched = 0;
  for (const term of candidates) {
    if (assistantTerms.has(term)) matched += 1;
    if (matched >= 2) return true;
  }
  return false;
}

function extractPayloadTerms(payload: unknown): string[] {
  const raw = stringifyPayload(payload);
  if (!raw) return [];
  const unique = new Set<string>();
  for (const token of raw.toLowerCase().split(/[^a-z0-9_./:-]+/)) {
    if (token.length < 4) continue;
    if (/^\d+$/.test(token) && token.length < 6) continue;
    unique.add(token);
    if (unique.size >= 24) break;
  }
  return [...unique];
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

function normalizeText(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9_./:-]+/)) {
    if (token.length < 4) continue;
    out.add(token);
  }
  return out;
}

function isErrorPayload(payload: unknown): boolean {
  if (typeof payload === "string") return /\berror\b|\bfailed\b|\bexception\b/i.test(payload);
  if (!payload || typeof payload !== "object") return false;
  if ("error" in payload || "errors" in payload) return true;
  const status = "status" in payload ? (payload as { status?: unknown }).status : undefined;
  if (typeof status === "string" && /error|failed/i.test(status)) return true;
  return false;
}

function sampleErrorText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const obj = payload as Record<string, unknown>;
  const candidate = obj.error ?? obj.message ?? obj.status ?? obj.errors;
  if (typeof candidate === "string") return candidate;
  return stringifyPayload(candidate ?? payload);
}

function normalizeFailureReason(text: string, payload: unknown): string {
  const lower = `${text} ${stringifyPayload(payload)}`.toLowerCase();
  if (/auth|token|credential|unauthorized|401|master key|locked/.test(lower)) return "auth";
  if (/permission|forbidden|denied|403/.test(lower)) return "permission";
  if (/not found|enoent|404|missing|unknown/.test(lower)) return "not_found";
  if (/invalid|schema|validation|bad request|400|malformed/.test(lower)) return "validation";
  if (/timeout|timed out|deadline|aborted/.test(lower)) return "timeout";
  if (/rate.?limit|too many requests|429|quota/.test(lower)) return "rate_limited";
  if (/context|too long|max_tokens|token count|payload too large/.test(lower)) return "size_or_context";
  return "other";
}

function argShape(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return typeof payload;
  const shape: Record<string, string> = {};
  for (const key of Object.keys(payload as Record<string, unknown>).sort()) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) shape[key] = "array";
    else if (value === null) shape[key] = "null";
    else shape[key] = typeof value;
  }
  return JSON.stringify(shape);
}

function redactPotentialSecret(text: string): string {
  return text
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])-?[A-Za-z0-9_\-]{12,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]*(?:secret|token|password|credential|apikey|api_key)[A-Za-z0-9_-]*\b/gi, "[redacted]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)[=:]\s*[^\s,;}]+/gi, "$1=[redacted]");
}

function truncateForSample(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}