import { promises as fsp, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { readAppRows } from "@/lib/db/read-pool";
import { decryptIfNeeded, isEncrypted } from "@/lib/crypto/envelope";
import { FILES_DIR, isSafeFileName } from "@/lib/files";

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SpillGcResult {
  scanned: number;
  referenced: number;
  removed: number;
  removed_bytes: number;
}

export async function runSpillFileGc(opts: { retentionMs?: number; now?: number } = {}): Promise<SpillGcResult> {
  const now = opts.now ?? Date.now();
  const retentionMs = opts.retentionMs ?? getRetentionMs();
  let referenced: Set<string>;
  try {
    referenced = await collectReferencedFileNamesFromMessages();
  } catch (error) {
    // Without the reference set nothing may be deleted, and this is the one
    // place that must never guess: skip the tick and retry on the next one.
    console.warn(
      "[files] spill GC skipped this tick: could not read message references, no files deleted.",
      error,
    );
    return { scanned: 0, referenced: 0, removed: 0, removed_bytes: 0 };
  }
  let scanned = 0;
  let removed = 0;
  let removedBytes = 0;

  let entries: string[];
  try {
    entries = await fsp.readdir(FILES_DIR);
  } catch {
    return { scanned, referenced: referenced.size, removed, removed_bytes: removedBytes };
  }

  for (const name of entries) {
    if (!isSafeFileName(name)) continue;
    const abs = join(FILES_DIR, name);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    scanned++;
    if (referenced.has(name)) continue;
    if (now - stat.mtimeMs < retentionMs) continue;
    try {
      await fsp.unlink(abs);
      removed++;
      removedBytes += stat.size;
    } catch {
      // Best-effort cleanup; a concurrent reader or antivirus lock should not break a scheduler tick.
    }
  }
  return { scanned, referenced: referenced.size, removed, removed_bytes: removedBytes };
}

export function collectFileRefNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    collectFileLinks(value, out);
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectFileRefNames(JSON.parse(trimmed), out);
      } catch {
        // Plain strings cannot reference spill files.
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefNames(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;

  const obj = value as Record<string, unknown>;
  const type = obj.type;
  if (type === "file_reference" && obj.storage === "jarela" && typeof obj.ref === "string" && isSafeFileName(obj.ref)) {
    out.add(obj.ref);
  }
  if ((type === "image_ref" || type === "file_ref") && typeof obj.name === "string" && isSafeFileName(obj.name)) {
    out.add(obj.name);
  }
  const resultRef = obj.result_ref;
  if (resultRef && typeof resultRef === "object") {
    const name = (resultRef as Record<string, unknown>).name;
    if (typeof name === "string" && isSafeFileName(name)) out.add(name);
  }
  for (const child of Object.values(obj)) collectFileRefNames(child, out);
  return out;
}

function collectFileLinks(value: string, out: Set<string>): void {
  for (const match of value.matchAll(/\/api\/v1\/files\/([A-Za-z0-9._%-]+)/g)) {
    const rawName = match[1];
    if (!rawName) continue;
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // Keep the raw path segment.
    }
    if (isSafeFileName(name)) out.add(name);
  }
}

async function collectReferencedFileNamesFromMessages(): Promise<Set<string>> {
  const out = new Set<string>();
  // Whole-table scan that grows with the message log (measured 460ms for
  // 11k rows). On the synchronous writer it froze every handler for that
  // long, so this read runs on the worker pool.
  const rows = await readAppRows<{ content?: string | null; tool_events?: string | null; metadata?: string | null }>(
    "SELECT content, tool_events, metadata FROM messages",
  );
  for (const row of rows) {
    collectFileRefNames(row.content, out);
    collectFileRefNames(row.tool_events, out);
    collectFileRefNames(row.metadata, out);
  }
  return out;
}

/** Spill file names referenced by one thread's messages. Call before deleting the thread. */
export function collectThreadFileRefNames(threadId: string): Set<string> {
  const out = new Set<string>();
  const rows = getDb()
    .prepare("SELECT content, tool_events, metadata FROM messages WHERE thread_id=?")
    .all(threadId) as Array<{ content?: string | null; tool_events?: string | null; metadata?: string | null }>;
  for (const row of rows) {
    collectFileRefNames(row.content, out);
    collectFileRefNames(row.tool_events, out);
    collectFileRefNames(row.metadata, out);
  }
  return out;
}

/** Every stored text that can name a spill file, read once per cleanup call. */
interface ReferenceCells {
  /** `content`, `tool_events` and `metadata` of every message row. */
  messages: string[];
  /** Raw `memory_store` values, encrypted rows included. */
  memory: string[];
  /** Decrypted memory values, or null when they cannot be read (locked key). */
  decryptedMemory: string[] | null;
}

async function loadReferenceCells(): Promise<ReferenceCells> {
  const messageRows = await readAppRows<{
    content?: string | null;
    tool_events?: string | null;
    metadata?: string | null;
  }>("SELECT content, tool_events, metadata FROM messages");
  const messages: string[] = [];
  for (const row of messageRows) {
    if (row.content) messages.push(row.content);
    if (row.tool_events) messages.push(row.tool_events);
    if (row.metadata) messages.push(row.metadata);
  }

  const memory = (await readAppRows<{ value: string }>("SELECT value FROM memory_store")).map((row) => row.value);
  let decryptedMemory: string[] | null;
  try {
    decryptedMemory = memory.filter((value) => isEncrypted(value)).map((value) => decryptIfNeeded(value));
  } catch {
    // Encrypted values we cannot read (e.g. PIN-locked key) might reference the
    // file: the caller keeps everything, exactly as the per-name check did.
    decryptedMemory = null;
  }
  return { messages, memory, decryptedMemory };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which of `names` still appear in stored message text or memory.
 *
 * One scan of the stored text with a single alternation pattern instead of one
 * `LIKE '%name%'` full scan per file name. On an 11k-message database each of
 * those scans measured 280-350 ms, so deleting a thread with 20 attachments
 * used to block the event loop for ~6 s; this is one pass over the same text.
 *
 * Matching stays as broad as the SQL it replaces: a bare name anywhere in a
 * message column counts, whether or not it is JSON, and message/memory text is
 * compared case-insensitively. Only the decrypted memory values are compared
 * case-sensitively, as before, because they are not passed through SQL.
 */
function findReferencedNames(names: string[], cells: ReferenceCells): Set<string> {
  const found = new Set<string>();
  if (names.length === 0) return found;
  const byLowercase = new Map(names.map((name) => [name.toLowerCase(), name]));
  const pattern = new RegExp(names.map(escapeRegExp).join("|"), "gi");
  const scan = (haystack: string): void => {
    for (const match of haystack.matchAll(pattern)) {
      const name = byLowercase.get(match[0].toLowerCase());
      if (name) found.add(name);
    }
  };
  for (const cell of cells.messages) {
    if (found.size === names.length) return found;
    scan(cell);
  }
  for (const value of cells.memory) {
    if (found.size === names.length) return found;
    scan(value);
  }
  for (const value of cells.decryptedMemory ?? []) {
    if (found.size === names.length) return found;
    for (const name of names) {
      if (!found.has(name) && value.includes(name)) found.add(name);
    }
  }
  return found;
}

/**
 * Remove spill files right after their last referencing conversation is deleted,
 * instead of leaving private attachments on disk until the retention GC runs.
 * Files still mentioned by any other message or memory entry (including
 * encrypted memory) are kept.
 */
export async function removeFilesNoLongerReferenced(names: Iterable<string>): Promise<number> {
  const candidates = [...new Set(names)].filter(isSafeFileName);
  if (candidates.length === 0) return 0;

  let cells: ReferenceCells;
  try {
    cells = await loadReferenceCells();
  } catch (error) {
    console.warn("[files] keeping spill files: could not read stored references.", error);
    return 0;
  }
  if (cells.decryptedMemory === null) return 0;

  const stillReferenced = findReferencedNames(candidates, cells);
  let removed = 0;
  for (const name of candidates) {
    if (stillReferenced.has(name)) continue;
    try {
      unlinkSync(join(FILES_DIR, name));
      removed++;
    } catch {
      // Already gone or locked; the retention GC will retry.
    }
  }
  return removed;
}

function getRetentionMs(): number {
  const raw = process.env.JARELA_FILES_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS * DAY_MS;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? Math.floor(days * DAY_MS) : DEFAULT_RETENTION_DAYS * DAY_MS;
}