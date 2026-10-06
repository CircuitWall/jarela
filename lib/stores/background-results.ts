import { getDb } from "@/lib/db";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";

export const BACKGROUND_RESULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const BACKGROUND_RESULT_MAX_BYTES = 2 * 1024 * 1024;
export const BACKGROUND_RESULT_REF_PREFIX = "background-result:";
export interface DurableBackgroundResult {
  key: string;
  owner_thread_id: string;
  tool: string;
  status: "pending" | "done" | "error";
  started_at: number;
  finished_at: number | null;
  result: string | null;
  error: string | null;
}

export function createBackgroundResult(key: string, threadId: string, tool: string): void {
  const operation = getDb().prepare("SELECT thread_id FROM runtime_operations WHERE id=?").get(key) as { thread_id: string } | undefined;
  if (operation?.thread_id !== threadId) throw new Error("Background result owner does not match its operation");
  getDb().prepare(`INSERT INTO background_tool_results(key,thread_id,tool,status,started_at,expires_at)
    VALUES (?,?,?,'pending',?,?) ON CONFLICT(key) DO NOTHING`)
    .run(key, threadId, tool, Date.now(), Date.now() + BACKGROUND_RESULT_RETENTION_MS);
}

export function finishBackgroundResult(key: string, status: "done" | "error", result: string | null, error: string | null): void {
  const encoded = JSON.stringify({ result, error });
  if (Buffer.byteLength(encoded) > BACKGROUND_RESULT_MAX_BYTES) throw new Error("Background result envelope exceeds its storage budget");
  getDb().prepare("UPDATE background_tool_results SET status=?,payload=?,finished_at=?,expires_at=? WHERE key=? AND status='pending'")
    .run(status, encrypt(encoded), Date.now(), Date.now() + BACKGROUND_RESULT_RETENTION_MS, key);
}

export function getBackgroundResult(key: string, threadId: string, consume = false): DurableBackgroundResult | null {
  const row = getDb().prepare("SELECT * FROM background_tool_results WHERE key=? AND thread_id=? AND expires_at>?")
    .get(key, threadId, Date.now()) as (DurableBackgroundResult & { payload: string | null }) | undefined;
  if (!row) return null;
  const payload = row.payload ? JSON.parse(decryptIfNeeded(row.payload)) as { result: string | null; error: string | null } : { result: null, error: null };
  if (consume && row.status !== "pending") getDb().prepare("DELETE FROM background_tool_results WHERE key=? AND thread_id=?").run(key, threadId);
  return { key: row.key, owner_thread_id: threadId, tool: row.tool, status: row.status, started_at: row.started_at, finished_at: row.finished_at, ...payload };
}

export function listBackgroundResults(threadId: string): DurableBackgroundResult[] {
  const rows = getDb().prepare("SELECT key FROM background_tool_results WHERE thread_id=? AND expires_at>? ORDER BY started_at DESC LIMIT 256")
    .all(threadId, Date.now()) as Array<{ key: string }>;
  return rows.map((row) => getBackgroundResult(row.key, threadId)).filter((row): row is DurableBackgroundResult => row !== null);
}

export function interruptBackgroundResults(instanceId: string): void {
  const rows = getDb().prepare(`SELECT r.key FROM background_tool_results r JOIN runtime_operations o ON o.id=r.key
    WHERE r.status='pending' AND o.origin_instance<>?`).all(instanceId) as Array<{ key: string }>;
  for (const row of rows) finishBackgroundResult(row.key, "error", null,
    "Interrupted by process restart. The external action's outcome is unknown; do not automatically repeat it.");
  getDb().prepare("DELETE FROM background_tool_results WHERE expires_at<=?").run(Date.now());
}

export function backgroundResultReference(key: string): string {
  return `${BACKGROUND_RESULT_REF_PREFIX}${key}`;
}

export function readBackgroundResultReference(name: string, threadId: string | undefined, offset = 0, limit = 4096, consume = false, maxEncodedBytes = Infinity): Record<string, unknown> {
  if (!threadId || !name.startsWith(BACKGROUND_RESULT_REF_PREFIX)) return { ok: false, status: "unknown", error: "Background result owner context is required" };
  const key = name.slice(BACKGROUND_RESULT_REF_PREFIX.length);
  const record = getBackgroundResult(key, threadId);
  const contents = record?.status === "done" ? record.result : record?.status === "error" ? record.error : null;
  if (!record || contents === null) return { ok: false, status: "unknown", error: "No accessible background result for that reference" };
  const bytes = Buffer.from(contents, "utf8");
  const start = Math.min(bytes.length, Math.max(0, Math.floor(offset)));
  const length = Math.min(1024 * 1024, Math.max(1, Math.floor(limit)));
  if (start < bytes.length && (bytes[start] & 0xc0) === 0x80) return { ok: false, status: "unknown", error: "Offset splits a UTF-8 character" };
  let end = Math.min(bytes.length, start + length);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === start) {
    end = Math.min(bytes.length, start + length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
  }
  const page = () => ({ ok: true, status: "done", source_status: record.status, name, offset: start, limit: end - start, bytes: bytes.length,
    result: bytes.subarray(start, end).toString("utf8"), next_offset: end >= bytes.length ? null : end, done: end >= bytes.length });
  while (Buffer.byteLength(JSON.stringify(page())) > maxEncodedBytes) {
    if (end - start <= 4) return { ok: false, status: "unknown", error: "Inline output budget is too small for protected result paging" };
    end = start + Math.floor((end - start) / 2);
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
  }
  const response = page();
  if (consume && response.done) getBackgroundResult(key, threadId, true);
  return response;
}

export function backgroundResultExists(key: string, threadId: string): boolean {
  return !!getDb().prepare("SELECT 1 AS present FROM background_tool_results WHERE key=? AND thread_id=? AND expires_at>?")
    .get(key, threadId, Date.now());
}