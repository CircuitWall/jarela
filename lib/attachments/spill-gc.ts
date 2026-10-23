import { promises as fsp, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { decryptIfNeeded } from "@/lib/crypto/envelope";
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
  const referenced = collectReferencedFileNamesFromMessages();
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

function collectReferencedFileNamesFromMessages(): Set<string> {
  const out = new Set<string>();
  const rows = getDb()
    .prepare("SELECT content, tool_events, metadata FROM messages")
    .all() as Array<{ content?: string | null; tool_events?: string | null; metadata?: string | null }>;
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

function stillReferenced(name: string, encryptedMemory: () => string[] | null): boolean {
  const pattern = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const db = getDb();
  const inMessages = db.prepare(
    "SELECT 1 FROM messages WHERE content LIKE ? ESCAPE '\\' OR tool_events LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\' LIMIT 1",
  ).get(pattern, pattern, pattern);
  if (inMessages) return true;
  if (db.prepare("SELECT 1 FROM memory_store WHERE value LIKE ? ESCAPE '\\' LIMIT 1").get(pattern)) return true;
  const decrypted = encryptedMemory();
  // Encrypted values we cannot read (e.g. PIN-locked key) might reference the file: keep it.
  if (decrypted === null) return true;
  return decrypted.some((value) => value.includes(name));
}

function loadEncryptedMemoryValues(): string[] | null {
  const rows = getDb()
    .prepare("SELECT value FROM memory_store WHERE value LIKE 'enc:v1:%'")
    .all() as Array<{ value: string }>;
  try {
    return rows.map((row) => decryptIfNeeded(row.value));
  } catch {
    return null;
  }
}

/**
 * Remove spill files right after their last referencing conversation is deleted,
 * instead of leaving private attachments on disk until the retention GC runs.
 * Files still mentioned by any other message or memory entry (including
 * encrypted memory) are kept.
 */
export function removeFilesNoLongerReferenced(names: Iterable<string>): number {
  let removed = 0;
  let cached: string[] | null | undefined;
  const encryptedMemory = () => (cached === undefined ? (cached = loadEncryptedMemoryValues()) : cached);
  for (const name of names) {
    if (!isSafeFileName(name) || stillReferenced(name, encryptedMemory)) continue;
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