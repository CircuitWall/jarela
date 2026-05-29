// Filesystem walker + indexer for document RAG (ADR-0024).
//
// Walks each enabled document_source, identifies text files whose
// mtime/size differs from the indexed copy, re-chunks + re-embeds them.
// Files removed on disk are evicted (chunks + document row).
//
// Defaults are conservative on purpose: extension allowlist, size cap,
// directory denylist for VCS / build output. Binary files are skipped via
// a fast non-printable-byte heuristic on the first 4 KB.

import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { getDb } from "@/lib/db";
import { embedBestEffort } from "@/lib/embeddings";
import {
  listEnabledDocumentSources,
  markSourceScanned,
  type DocumentSourceRow,
} from "@/lib/stores/document-sources";
import { chunkText } from "./chunker";
import { isRemoteKind, runRemoteSource, type RemoteIndexStats } from "./remote";

// Conservative defaults; v1 is not configurable per source. ADR-0024
// documents the rationale and the path to opening these up.
const ALLOWED_EXT = new Set([
  ".md", ".markdown", ".txt", ".rst", ".log",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".scala", ".swift",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".rb", ".php", ".lua", ".pl", ".r",
  ".sh", ".bash", ".zsh", ".ps1", ".bat",
  ".html", ".htm", ".css", ".scss", ".sass", ".vue", ".svelte",
  ".sql", ".graphql", ".proto",
  ".csv", ".tsv",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".turbo", ".cache",
  "dist", "build", "out", "target", ".venv", "venv", "env",
  "__pycache__", ".pytest_cache", ".mypy_cache",
  ".idea", ".vscode", ".vs",
  "coverage", ".nyc_output",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB — bigger files almost always
                                        // belong in proper RAG, not ad-hoc.
const MAX_FILES_PER_SOURCE = 5000;
// Per-call cap so a freshly-added source with thousands of files doesn't
// block the scheduler tick for minutes. Subsequent ticks pick up the rest.
const MAX_INDEX_PER_TICK_PER_SOURCE = 50;

export { ALLOWED_EXT, SKIP_DIRS, MAX_FILE_BYTES };

export function lowerExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

export function isLikelyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    // NUL byte = almost certainly binary.
    if (b === 0) return true;
    // Outside printable ASCII + common whitespace and not high-bit UTF-8.
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++;
  }
  return suspicious / len > 0.05;
}

export interface FileEntry {
  abs: string;
  rel: string;
  mtime_ms: number;
  size: number;
}

async function walk(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  // Cloud-synced filesystems (OneDrive's macOS file provider in
  // particular) can re-emit the same entry from readdir during sync
  // transitions, sometimes with a different Unicode normalization
  // (NFC vs NFD). Without dedupe, the second visit would attempt a
  // second INSERT for the same (source_id, path) and trip the UNIQUE
  // constraint on `documents`.
  const seen = new Set<string>();
  async function visit(dir: string): Promise<void> {
    if (out.length >= MAX_FILES_PER_SOURCE) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_SOURCE) return;
      if (e.name.startsWith(".")) {
        // Hide dot-dirs by default. Users who want them indexed should
        // pick a more specific subdirectory as the source.
        if (e.isDirectory()) continue;
        // Keep dot-files like .env, .gitignore as text candidates.
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        await visit(abs);
      } else if (e.isFile()) {
        const ext = lowerExt(e.name);
        if (!ALLOWED_EXT.has(ext)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        out.push({
          abs,
          rel: relative(root, abs).split(sep).join("/"),
          mtime_ms: Math.floor(st.mtimeMs),
          size: st.size,
        });
      }
    }
  }
  await visit(root);
  return out;
}

interface IndexedDocRow {
  id: string;
  path: string;
  mtime_ms: number;
  size_bytes: number;
  content_hash: string;
}

function listIndexedDocs(sourceId: string): Map<string, IndexedDocRow> {
  const rows = getDb()
    .prepare("SELECT id, path, mtime_ms, size_bytes, content_hash FROM documents WHERE source_id=?")
    .all(sourceId) as unknown as IndexedDocRow[];
  const map = new Map<string, IndexedDocRow>();
  for (const r of rows) map.set(r.path, r);
  return map;
}

interface UnembeddedChunkRow {
  id: string;
  text: string;
}

function listUnembeddedChunks(documentId: string): UnembeddedChunkRow[] {
  return getDb()
    .prepare(
      `SELECT id, text
       FROM document_chunks
       WHERE document_id=? AND embedding IS NULL
       ORDER BY chunk_index ASC`,
    )
    .all(documentId) as unknown as UnembeddedChunkRow[];
}

async function backfillDocumentEmbeddings(documentId: string): Promise<{ missing: number; embedded: number; embedError: string | null }> {
  const rows = listUnembeddedChunks(documentId);
  if (rows.length === 0) return { missing: 0, embedded: 0, embedError: null };

  const { vectors, error } = await embedBestEffort(rows.map((r) => r.text));
  const updateEmb = getDb().prepare("UPDATE document_chunks SET embedding=? WHERE id=?");
  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = vectors[i];
    if (v == null) continue;
    updateEmb.run(JSON.stringify(v), rows[i].id);
    embedded++;
  }
  return { missing: rows.length, embedded, embedError: error };
}

export async function readTextFile(abs: string): Promise<string | null> {
  let buf: Buffer;
  try { buf = await fs.readFile(abs); } catch { return null; }
  if (isLikelyBinary(buf)) return null;
  return buf.toString("utf8");
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface IndexStats {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  errors: number;
  embed_failed?: number;
  embed_error?: string | null;
}

export async function indexSource(
  source: DocumentSourceRow,
  opts?: { maxFiles?: number },
): Promise<IndexStats> {
  const stats: IndexStats = { scanned: 0, added: 0, updated: 0, removed: 0, unchanged: 0, errors: 0 };
  const db = getDb();
  let lastError: string | null = null;
  let embedFailed = 0;
  let embedError: string | null = null;

  // Resolve real files on disk.
  const files = await walk(source.path);
  stats.scanned = files.length;

  const indexed = listIndexedDocs(source.id);
  const onDisk = new Set<string>(files.map((f) => f.abs));

  // Drop entries whose file is gone.
  for (const [path, row] of indexed.entries()) {
    if (!onDisk.has(path)) {
      db.prepare("DELETE FROM documents WHERE id=?").run(row.id);
      stats.removed++;
    }
  }

  // Index new + changed files.
  const maxThisRun = opts?.maxFiles ?? MAX_INDEX_PER_TICK_PER_SOURCE;
  let processed = 0;
  for (const f of files) {
    if (processed >= maxThisRun) break;
    const existing = indexed.get(f.abs);
    if (existing && existing.mtime_ms === f.mtime_ms && existing.size_bytes === f.size) {
      // Root-cause fix: if a file was indexed while embeddings were
      // unavailable, unchanged files used to be skipped forever and never
      // backfilled. Try to embed any still-null chunks on unchanged docs.
      try {
        const r = await backfillDocumentEmbeddings(existing.id);
        if (r.missing > 0) {
          embedFailed += Math.max(r.missing - r.embedded, 0);
          if (r.embedError && !embedError) embedError = r.embedError;
          processed++;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        stats.errors++;
      }
      stats.unchanged++;
      continue;
    }

    let text: string | null;
    try { text = await readTextFile(f.abs); } catch {
      stats.errors++;
      continue;
    }
    if (text === null) continue; // binary / unreadable — skip silently.

    const hash = hashContent(text);
    if (existing && existing.content_hash === hash) {
      // Mtime/size changed but content didn't — just touch the row.
      db.prepare("UPDATE documents SET mtime_ms=?, size_bytes=?, last_indexed_at=? WHERE id=?")
        .run(f.mtime_ms, f.size, new Date().toISOString(), existing.id);
      try {
        const r = await backfillDocumentEmbeddings(existing.id);
        if (r.missing > 0) {
          embedFailed += Math.max(r.missing - r.embedded, 0);
          if (r.embedError && !embedError) embedError = r.embedError;
          processed++;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        stats.errors++;
      }
      stats.unchanged++;
      continue;
    }

    try {
      const r = await upsertLocalDocument(source.id, f, text, hash, existing?.id);
      embedFailed += r.chunks - r.embedded;
      if (r.embedError && !embedError) embedError = r.embedError;
      processed++;
      if (existing) stats.updated++;
      else stats.added++;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      stats.errors++;
    }
  }

  // Embed failures are not fetch failures — but if everything else
  // succeeded we still want them visible on the row, so the operator
  // doesn't have to grep server logs to discover that semantic search
  // is degraded for this source.
  const composite = lastError
    ? lastError
    : embedFailed > 0
      ? `${embedFailed} chunk${embedFailed === 1 ? "" : "s"} failed to embed${embedError ? ": " + embedError : ""}`
      : null;
  if (embedFailed > 0) {
    stats.embed_failed = embedFailed;
    stats.embed_error = embedError;
  }
  markSourceScanned(source.id, composite);
  return stats;
}

/**
 * Upsert one local document row (and its chunks). Exported so
 * single-file watcher firings can reuse it without going through
 * a full source sweep.
 */
export async function upsertLocalDocument(
  sourceId: string,
  f: FileEntry,
  text: string,
  hash: string,
  existingId: string | undefined,
): Promise<{ chunks: number; embedded: number; embedError: string | null }> {
  const db = getDb();
  const t = new Date().toISOString();
  const docId = existingId ?? randomUUID();

  // Two writers can race on (source_id, path): the full sweep in
  // indexSource() loads listIndexedDocs() once and iterates, while
  // fs-watch firings call reindexLocalFile() per file. If a watcher
  // event lands mid-sweep, both paths can see "no existing row" and
  // both try to INSERT, tripping UNIQUE(source_id, path)
  // (lib/db/migrations.ts). REPLACE INTO is unsafe: document_chunks
  // has ON DELETE CASCADE on documents.id, so REPLACE would nuke every
  // chunk on each call. Use ON CONFLICT DO NOTHING, and if we lost the
  // race, adopt the winner's id and overwrite via UPDATE so the latest
  // content still wins.
  let writeId = docId;
  if (existingId) {
    db.prepare(
      `UPDATE documents
       SET path=?, rel_path=?, mtime_ms=?, size_bytes=?, content_hash=?, last_indexed_at=?
       WHERE id=?`,
    ).run(f.abs, f.rel, f.mtime_ms, f.size, hash, t, existingId);
    db.prepare("DELETE FROM document_chunks WHERE document_id=?").run(existingId);
    writeId = existingId;
  } else {
    const info = db.prepare(
      `INSERT INTO documents
       (id, source_id, path, rel_path, mtime_ms, size_bytes, content_hash, last_indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(source_id, path) DO NOTHING`,
    ).run(docId, sourceId, f.abs, f.rel, f.mtime_ms, f.size, hash, t);
    if (info.changes === 0) {
      const winner = db
        .prepare("SELECT id FROM documents WHERE source_id=? AND path=?")
        .get(sourceId, f.abs) as { id: string } | undefined;
      if (winner) {
        db.prepare(
          `UPDATE documents
           SET rel_path=?, mtime_ms=?, size_bytes=?, content_hash=?, last_indexed_at=?
           WHERE id=?`,
        ).run(f.rel, f.mtime_ms, f.size, hash, t, winner.id);
        db.prepare("DELETE FROM document_chunks WHERE document_id=?").run(winner.id);
        writeId = winner.id;
      }
    }
  }

  return chunkAndEmbedDocument(writeId, text, f.rel);
}

/**
 * Chunk a document's text, persist the chunks, and best-effort embed
 * them. Shared between the local sweep, single-file watcher firings,
 * and remote-source upserts. Returns counts so the caller can aggregate
 * embed failures up to the source row instead of swallowing them.
 */
export async function chunkAndEmbedDocument(
  documentId: string,
  text: string,
  _label: string,
): Promise<{ chunks: number; embedded: number; embedError: string | null }> {
  const db = getDb();
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    db.prepare("UPDATE documents SET chunk_count=0 WHERE id=?").run(documentId);
    return { chunks: 0, embedded: 0, embedError: null };
  }

  // Insert chunks first without embeddings — recall falls back to
  // substring scan, so they're useful immediately. Then attempt to embed
  // in a single batch; persist whichever vectors came back.
  const insertChunk = db.prepare(
    `INSERT INTO document_chunks
     (id, document_id, chunk_index, text, start_offset, end_offset, embedding)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const id = randomUUID();
    chunkIds.push(id);
    insertChunk.run(id, documentId, i, chunks[i].text, chunks[i].start_offset, chunks[i].end_offset);
  }
  db.prepare("UPDATE documents SET chunk_count=? WHERE id=?").run(chunks.length, documentId);

  // embedBestEffort handles retry + halving fallback internally so a
  // single bad input or transient 429 doesn't drop the whole document.
  const { vectors, error } = await embedBestEffort(chunks.map((c) => c.text));
  const updateEmb = db.prepare("UPDATE document_chunks SET embedding=? WHERE id=?");
  let embedded = 0;
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i] != null) {
      updateEmb.run(JSON.stringify(vectors[i]), chunkIds[i]);
      embedded++;
    }
  }
  return { chunks: chunks.length, embedded, embedError: error };
}

export async function indexAllSources(opts?: { maxFilesPerSource?: number }): Promise<{
  source_id: string;
  path: string;
  stats: IndexStats | RemoteIndexStats;
}[]> {
  const sources = listEnabledDocumentSources();
  const out: { source_id: string; path: string; stats: IndexStats | RemoteIndexStats }[] = [];
  for (const s of sources) {
    try {
      if (isRemoteKind(s.kind)) {
        // Delegate to the per-kind remote handler (ADR-0026). Remote
        // sources don't have an mtime stat — they have their own
        // incremental cursor stored in document_sources.last_cursor.
        const stats = await runRemoteSource(s);
        out.push({ source_id: s.id, path: s.path, stats });
        continue;
      }
      const stats = await indexSource(s, { maxFiles: opts?.maxFilesPerSource });
      out.push({ source_id: s.id, path: s.path, stats });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markSourceScanned(s.id, msg);
      console.error("[documents] index failed for", s.path, msg);
    }
  }
  return out;
}
