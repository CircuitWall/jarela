// Document-index lifecycle (ADR-0133).
//
// Post-ingestion management over `documents` / `document_chunks`:
//
//   - purge one source's index while keeping the source row (files and
//     upstream content are untouched; the next sweep re-indexes it),
//   - opt-in retention that purges disabled sources after a grace period,
//   - per-source chunk counters for the Documents panel,
//   - live space reclamation: bounded incremental vacuum, plus the explicit
//     one-time full VACUUM that switches an existing database to incremental
//     auto-vacuum.
//
// The write connection is synchronous, so deleting 177k chunks (measured on a
// live install) or vacuuming a 3 GB file on it would freeze every handler and
// stream. Maintenance writes therefore run on a dedicated writer worker pool,
// one action at a time, and incremental reclaim yields between batches so app
// writes can interleave.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type sqlite3Type from "@appthreat/sqlite3";
import { DB_PATH, getDb } from "@/lib/db";
import { readAppRows } from "@/lib/db/read-pool";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { errorMessage } from "@/lib/utils/error";
import {
  getDocumentIndexLifecycleSettings,
  setDocumentIndexLifecycleSettings,
} from "@/lib/stores/app-settings";
import { listDocumentSources, type DocumentSourceRow } from "@/lib/stores/document-sources";
import type {
  DocumentIndexAutoVacuum,
  DocumentIndexInventory,
  DocumentIndexLifecycleSettings,
  DocumentIndexMaintenanceActionName,
  DocumentIndexMaintenanceStatus,
} from "@/api/document-lifecycle";
import { decodeEmbedding, encodeEmbedding } from "./embedding-codec";
import { refreshDocumentSourceStats } from "./source-stats-cache";

type MaintenancePool = Awaited<ReturnType<typeof sqlite3Type.pool>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECLAIM_BATCH_PAGES = 2_000;
const RECLAIM_YIELD_MS = 20;
const DEFAULT_RECLAIM_BUDGET_MS = 60_000;
const POST_PURGE_RECLAIM_BUDGET_MS = 30_000;
const SCHEDULER_RECLAIM_BUDGET_MS = 10_000;

// ---------------------------------------------------------------------------
// Writer worker pool
// ---------------------------------------------------------------------------

interface LifecycleRuntime {
  pool: Promise<MaintenancePool> | null;
  status: DocumentIndexMaintenanceStatus;
  current: Promise<void> | null;
  // The app connection caches some file-header pragmas for its lifetime, so
  // remember a mode we enabled in this process until the next restart.
  autoVacuumOverride: DocumentIndexAutoVacuum | null;
}

const runtime = getOrCreateGlobal<LifecycleRuntime>("__jarela_document_index_lifecycle", () => ({
  pool: null,
  status: emptyStatus(),
  current: null,
  autoVacuumOverride: null,
}));

function emptyStatus(): DocumentIndexMaintenanceStatus {
  return {
    running: false,
    action: null,
    started_at: null,
    finished_at: null,
    summary: null,
    error: null,
  };
}

function snapshot(): DocumentIndexMaintenanceStatus {
  return { ...runtime.status };
}

function maintenancePool(): Promise<MaintenancePool> {
  if (!runtime.pool) {
    runtime.pool = import("@appthreat/sqlite3")
      .then(async ({ default: sqlite3 }) => {
        const pool = await sqlite3.pool(DB_PATH, { readers: 0, walMode: true, busyTimeout: 5000 });
        // The pool cannot use applyConnectionPragmas (ADR-0124); replicate the
        // one pragma this connection's deletes depend on. Deletes also list
        // chunks explicitly, so a lost setting cannot orphan rows.
        await pool.exec("PRAGMA foreign_keys = ON");
        return pool;
      })
      .catch((error: unknown) => {
        runtime.pool = null;
        throw error;
      });
  }
  return runtime.pool;
}

/** Close the maintenance writer during shutdown and between isolated tests. */
export async function closeDocumentIndexMaintenancePool(): Promise<void> {
  const current = runtime.pool;
  runtime.pool = null;
  if (current) await (await current).close();
}

async function poolPragma(pool: MaintenancePool, name: string): Promise<number> {
  const row = await pool.get(`PRAGMA ${name}`);
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === "number" ? value : Number(value) || 0;
}

function pragmaNumber(db: ReturnType<typeof getDb>, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === "number" ? value : Number(value) || 0;
}

function autoVacuumName(value: number): DocumentIndexAutoVacuum {
  return value === 2 ? "incremental" : value === 1 ? "full" : "none";
}

// ---------------------------------------------------------------------------
// Inventory and settings
// ---------------------------------------------------------------------------

export interface DocumentIndexLifecycleState {
  settings: DocumentIndexLifecycleSettings;
  inventory: DocumentIndexInventory;
  status: DocumentIndexMaintenanceStatus;
}

/**
 * Cheap index inventory. Both database counters and the document aggregate
 * are index/header reads; nothing here scans `document_chunks`.
 */
export async function getDocumentIndexInventory(): Promise<DocumentIndexInventory> {
  const db = getDb();
  const pageSize = pragmaNumber(db, "page_size");
  const pageCount = pragmaNumber(db, "page_count");
  const freelist = pragmaNumber(db, "freelist_count");
  const rows = await readAppRows<{ document_count: number; chunk_count: number }>(
    "SELECT COUNT(*) AS document_count, COALESCE(SUM(chunk_count), 0) AS chunk_count FROM documents",
  );
  return {
    document_count: Number(rows[0]?.document_count) || 0,
    chunk_count: Number(rows[0]?.chunk_count) || 0,
    size_bytes: pageSize * pageCount,
    free_bytes: pageSize * freelist,
    auto_vacuum: runtime.autoVacuumOverride ?? autoVacuumName(pragmaNumber(db, "auto_vacuum")),
  };
}

export async function readDocumentIndexLifecycleState(): Promise<DocumentIndexLifecycleState> {
  return {
    settings: getDocumentIndexLifecycleSettings(),
    inventory: await getDocumentIndexInventory(),
    status: snapshot(),
  };
}

export function saveDocumentIndexLifecycleSettings(
  patch: Partial<DocumentIndexLifecycleSettings>,
): DocumentIndexLifecycleSettings {
  return setDocumentIndexLifecycleSettings(patch);
}

export function getDocumentIndexMaintenanceStatus(): DocumentIndexMaintenanceStatus {
  return snapshot();
}

// ---------------------------------------------------------------------------
// Purging
// ---------------------------------------------------------------------------

export interface PurgeSourceIndexResult {
  source_id: string;
  documents: number;
  chunks: number;
}

export interface PurgeDisabledSourcesResult {
  sources: PurgeSourceIndexResult[];
  documents: number;
  chunks: number;
}

/**
 * Delete one source's documents and chunks in a single worker transaction.
 * The `document_sources` row, its config, and the files on disk stay in place;
 * removing the `documents` rows makes the next sweep treat every file as new.
 */
async function deleteSourceIndex(sourceId: string): Promise<PurgeSourceIndexResult> {
  const pool = await maintenancePool();
  const deleted = await pool.transaction(async (tx) => {
    const chunks = await tx.write(
      "DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE source_id=?)",
      [sourceId],
    );
    const documents = await tx.write("DELETE FROM documents WHERE source_id=?", [sourceId]);
    return { documents: Number(documents.changes) || 0, chunks: Number(chunks.changes) || 0 };
  }, { mode: "immediate" });
  return { source_id: sourceId, ...deleted };
}

export async function purgeSourceIndex(sourceId: string): Promise<PurgeSourceIndexResult> {
  const result = await deleteSourceIndex(sourceId);
  await refreshDocumentSourceStats().catch(() => undefined);
  return result;
}

/**
 * Purge disabled sources. `olderThanDays: null` purges every disabled source
 * (the explicit "Purge disabled" button); a number applies the retention
 * window and skips rows whose `disabled_at` is unknown.
 */
export async function purgeDisabledSourceIndexes(opts?: {
  olderThanDays?: number | null;
  now?: Date;
}): Promise<PurgeDisabledSourcesResult> {
  const olderThanDays = opts?.olderThanDays ?? null;
  const cutoff = olderThanDays === null
    ? null
    : new Date((opts?.now ?? new Date()).getTime() - olderThanDays * DAY_MS).toISOString();
  const targets = listDocumentSources().filter((source) => source.enabled === 0
    && (cutoff === null || (source.disabled_at !== null && source.disabled_at <= cutoff)));
  const sources: PurgeSourceIndexResult[] = [];
  for (const source of targets) sources.push(await deleteSourceIndex(source.id));
  if (sources.length > 0) await refreshDocumentSourceStats().catch(() => undefined);
  return {
    sources,
    documents: sources.reduce((sum, source) => sum + source.documents, 0),
    chunks: sources.reduce((sum, source) => sum + source.chunks, 0),
  };
}

/** Sources a retention sweep would purge right now. */
export function disabledSourcesPastRetention(
  olderThanDays: number,
  now: Date = new Date(),
): DocumentSourceRow[] {
  if (olderThanDays <= 0) return [];
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS).toISOString();
  return listDocumentSources().filter((source) => source.enabled === 0
    && source.disabled_at !== null && source.disabled_at <= cutoff);
}

// ---------------------------------------------------------------------------
// Embedding storage format (ADR-0134)
// ---------------------------------------------------------------------------

export interface RewriteEmbeddingFormatResult {
  scanned: number;
  rewritten: number;
  skipped: number;
  bytes_before: number;
  bytes_after: number;
  completed: boolean;
}

const REWRITE_BATCH_ROWS = 500;
const DEFAULT_REWRITE_BUDGET_MS = 60_000;

/**
 * Rewrite legacy JSON-text embeddings as float32 BLOBs. New writes use the
 * compact format already; this converts existing rows in bounded batches on
 * the worker so search keeps working while it runs. Resumable: a partial run
 * returns `completed: false` and the next call continues from the start of the
 * remaining text rows.
 */
export async function rewriteLegacyDocumentEmbeddings(opts?: {
  batchSize?: number;
  budgetMs?: number;
}): Promise<RewriteEmbeddingFormatResult> {
  const pool = await maintenancePool();
  const requestedBatch = opts?.batchSize;
  const batchSize = typeof requestedBatch === "number" && Number.isFinite(requestedBatch)
    ? Math.max(1, Math.min(Math.floor(requestedBatch), 5_000))
    : REWRITE_BATCH_ROWS;
  const deadline = Date.now() + (opts?.budgetMs ?? DEFAULT_REWRITE_BUDGET_MS);
  const result: RewriteEmbeddingFormatResult = {
    scanned: 0, rewritten: 0, skipped: 0, bytes_before: 0, bytes_after: 0, completed: false,
  };
  let cursor = "";
  while (Date.now() < deadline) {
    const rows = await pool.read(
      `SELECT id, embedding FROM document_chunks
        WHERE typeof(embedding)='text' AND id > ?
        ORDER BY id LIMIT ?`,
      [cursor, batchSize],
    ) as Array<{ id: string; embedding: string | Uint8Array }>;
    if (rows.length === 0) {
      result.completed = true;
      break;
    }
    result.scanned += rows.length;
    cursor = String(rows[rows.length - 1].id);
    const updates: Array<{ id: string; blob: Uint8Array; before: number }> = [];
    for (const row of rows) {
      const vector = decodeEmbedding(row.embedding);
      if (!vector) {
        result.skipped += 1;
        continue;
      }
      const before = typeof row.embedding === "string" ? Buffer.byteLength(row.embedding, "utf8") : 0;
      updates.push({ id: String(row.id), blob: encodeEmbedding(vector), before });
    }
    if (updates.length > 0) {
      result.rewritten += await pool.transaction(async (tx) => {
        let changed = 0;
        for (const update of updates) {
          const written = await tx.write(
            "UPDATE document_chunks SET embedding=? WHERE id=? AND typeof(embedding)='text'",
            [update.blob, update.id],
          );
          if (Number(written.changes) > 0) {
            changed += 1;
            result.bytes_before += update.before;
            result.bytes_after += update.blob.byteLength;
          }
        }
        return changed;
      }, { mode: "immediate" });
    }
    if (rows.length < batchSize) {
      result.completed = true;
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Space reclamation
// ---------------------------------------------------------------------------

export interface ReclaimIndexSpaceResult {
  auto_vacuum: DocumentIndexAutoVacuum;
  free_bytes_before: number;
  free_bytes_after: number;
  reclaimed_bytes: number;
  completed: boolean;
}

/**
 * Reclaim free pages without a full rewrite. Requires incremental auto-vacuum
 * (new databases enable it at creation; existing databases need one explicit
 * compaction). Batches bounded pages and yields between them so concurrent app
 * writes are not locked out for the whole reclaim.
 */
export async function reclaimIndexSpace(opts?: {
  budgetMs?: number;
  batchPages?: number;
}): Promise<ReclaimIndexSpaceResult> {
  const pool = await maintenancePool();
  const pageSize = await poolPragma(pool, "page_size");
  const mode = autoVacuumName(await poolPragma(pool, "auto_vacuum"));
  if (mode === "none") {
    throw new Error(
      "This database does not use incremental auto-vacuum yet. Run database compaction once to enable live space reclamation.",
    );
  }
  const freeBefore = await poolPragma(pool, "freelist_count");
  if (mode === "full") {
    // Full auto-vacuum truncates freed pages at commit; there is nothing for
    // incremental_vacuum to do.
    return {
      auto_vacuum: mode,
      free_bytes_before: freeBefore * pageSize,
      free_bytes_after: freeBefore * pageSize,
      reclaimed_bytes: 0,
      completed: true,
    };
  }
  const requestedBatch = opts?.batchPages;
  const batchPages = typeof requestedBatch === "number" && Number.isFinite(requestedBatch)
    ? Math.max(1, Math.min(Math.floor(requestedBatch), 100_000))
    : RECLAIM_BATCH_PAGES;
  const deadline = Date.now() + (opts?.budgetMs ?? DEFAULT_RECLAIM_BUDGET_MS);
  let free = freeBefore;
  while (free > 0 && Date.now() < deadline) {
    await pool.exec(`PRAGMA incremental_vacuum(${Math.min(free, batchPages)})`);
    const next = await poolPragma(pool, "freelist_count");
    if (next >= free) break;
    free = next;
    await sleep(RECLAIM_YIELD_MS);
  }
  const freeAfter = await poolPragma(pool, "freelist_count");
  return {
    auto_vacuum: mode,
    free_bytes_before: freeBefore * pageSize,
    free_bytes_after: freeAfter * pageSize,
    reclaimed_bytes: Math.max(0, freeBefore - freeAfter) * pageSize,
    completed: freeAfter === 0,
  };
}

export interface VacuumIndexDatabaseResult {
  size_bytes_before: number;
  size_bytes_after: number;
  reclaimed_bytes: number;
  auto_vacuum: "incremental";
}

/**
 * One-time full VACUUM. Rewrites the file, reclaiming every free page and
 * switching existing databases to incremental auto-vacuum (the pragma only
 * takes effect across a VACUUM). Needs disk space for the compacted copy and
 * holds SQLite's write lock for the rewrite; callers must treat it as an
 * explicit, warned maintenance action.
 */
export async function vacuumIndexDatabase(): Promise<VacuumIndexDatabaseResult> {
  const pool = await maintenancePool();
  const pageSize = await poolPragma(pool, "page_size");
  const pagesBefore = await poolPragma(pool, "page_count");
  const freelistBefore = await poolPragma(pool, "freelist_count");
  const sizeBefore = pagesBefore * pageSize;
  const required = Math.max(0, pagesBefore - freelistBefore) * pageSize;
  const available = await availableBytes(dirname(DB_PATH));
  if (available !== null && available < required) {
    throw new Error(
      `Not enough free disk space to compact the database: ${formatBytes(available)} available, ${formatBytes(required)} required.`,
    );
  }
  await pool.exec("PRAGMA auto_vacuum = INCREMENTAL");
  await pool.exec("VACUUM");
  runtime.autoVacuumOverride = "incremental";
  const sizeAfter = (await poolPragma(pool, "page_count")) * pageSize;
  return {
    size_bytes_before: sizeBefore,
    size_bytes_after: sizeAfter,
    reclaimed_bytes: Math.max(0, sizeBefore - sizeAfter),
    auto_vacuum: "incremental",
  };
}

async function availableBytes(directory: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(directory);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) ? available : null;
  } catch {
    return null; // best effort; SQLite reports the real failure
  }
}

// ---------------------------------------------------------------------------
// Background action runner
// ---------------------------------------------------------------------------

export interface MaintenanceJob {
  action: DocumentIndexMaintenanceActionName;
  source_id?: string;
  retentionDays?: number;
}

export interface MaintenanceStart {
  started: boolean;
  status: DocumentIndexMaintenanceStatus;
}

/**
 * Start one maintenance action in the background. Returns immediately with
 * `started: false` if another action is still running; callers poll
 * `getDocumentIndexMaintenanceStatus()` for the outcome.
 */
export function startDocumentIndexMaintenance(job: MaintenanceJob): MaintenanceStart {
  if (runtime.status.running) return { started: false, status: snapshot() };
  runtime.status = {
    running: true,
    action: job.action,
    started_at: new Date().toISOString(),
    finished_at: null,
    summary: null,
    error: null,
  };
  runtime.current = runMaintenance(job)
    .then((summary) => { runtime.status.summary = summary; })
    .catch((error: unknown) => { runtime.status.error = errorMessage(error); })
    .finally(() => {
      runtime.status.running = false;
      runtime.status.finished_at = new Date().toISOString();
      runtime.current = null;
    });
  return { started: true, status: snapshot() };
}

async function runMaintenance(job: MaintenanceJob): Promise<string> {
  switch (job.action) {
    case "purge_source": {
      if (!job.source_id) throw new Error("source_id is required");
      const result = await purgeSourceIndex(job.source_id);
      return summarizePurge([result], await reclaimQuietly(POST_PURGE_RECLAIM_BUDGET_MS));
    }
    case "purge_disabled": {
      const result = await purgeDisabledSourceIndexes({ olderThanDays: null });
      return summarizePurge(result.sources, await reclaimQuietly(POST_PURGE_RECLAIM_BUDGET_MS));
    }
    case "reclaim": {
      const result = await reclaimIndexSpace();
      return summarizeReclaim(result);
    }
    case "rewrite_embeddings": {
      const result = await rewriteLegacyDocumentEmbeddings();
      return summarizeRewrite(result, await reclaimQuietly(POST_PURGE_RECLAIM_BUDGET_MS));
    }
    case "vacuum": {
      const result = await vacuumIndexDatabase();
      return `Compacted the database: ${formatBytes(result.reclaimed_bytes)} reclaimed.`;
    }
    case "lifecycle": {
      const parts: string[] = [];
      if ((job.retentionDays ?? 0) > 0) {
        const result = await purgeDisabledSourceIndexes({ olderThanDays: job.retentionDays });
        if (result.sources.length > 0) parts.push(summarizePurge(result.sources, null));
      }
      const reclaimed = await reclaimQuietly(SCHEDULER_RECLAIM_BUDGET_MS);
      if (reclaimed && reclaimed.reclaimed_bytes > 0) parts.push(summarizeReclaim(reclaimed));
      return parts.length > 0 ? parts.join(" ") : "No document index maintenance was due.";
    }
  }
}

async function reclaimQuietly(budgetMs: number): Promise<ReclaimIndexSpaceResult | null> {
  try {
    return await reclaimIndexSpace({ budgetMs });
  } catch (error) {
    // Incremental reclaim is opportunistic after a purge. A database that
    // still needs its one-time compaction is reported through the inventory,
    // not as a failed purge.
    console.warn("[documents] space reclamation skipped:", errorMessage(error));
    return null;
  }
}

function summarizePurge(
  sources: PurgeSourceIndexResult[],
  reclaimed: ReclaimIndexSpaceResult | null,
): string {
  const documents = sources.reduce((sum, source) => sum + source.documents, 0);
  const chunks = sources.reduce((sum, source) => sum + source.chunks, 0);
  if (sources.length === 0) return "No disabled sources have indexed content to purge.";
  const purged = `Purged ${chunks.toLocaleString()} chunks from ${documents.toLocaleString()} documents in ${sources.length} source${sources.length === 1 ? "" : "s"}.`;
  if (!reclaimed) {
    return `${purged} Run database compaction to return the freed pages to the filesystem.`;
  }
  if (reclaimed.reclaimed_bytes === 0 && reclaimed.completed) return purged;
  return `${purged} ${summarizeReclaim(reclaimed)}`;
}

function summarizeReclaim(result: ReclaimIndexSpaceResult): string {
  const pending = result.completed ? "" : ` ${formatBytes(result.free_bytes_after)} still pending; run it again to continue.`;
  return `Reclaimed ${formatBytes(result.reclaimed_bytes)}.${pending}`;
}

function summarizeRewrite(
  result: RewriteEmbeddingFormatResult,
  reclaimed: ReclaimIndexSpaceResult | null,
): string {
  if (result.scanned === 0) return "No legacy JSON embeddings remain.";
  const skipped = result.skipped > 0 ? `; ${result.skipped.toLocaleString()} invalid rows skipped` : "";
  const base = `Rewrote ${result.rewritten.toLocaleString()} of ${result.scanned.toLocaleString()} legacy embeddings `
    + `(${formatBytes(result.bytes_before)} → ${formatBytes(result.bytes_after)})${skipped}.`;
  if (!result.completed) return `${base} Run it again to continue.`;
  if (reclaimed === null) {
    return `${base} Run database compaction to return the freed pages to the filesystem.`;
  }
  return reclaimed.reclaimed_bytes > 0
    ? `${base} Reclaimed ${formatBytes(reclaimed.reclaimed_bytes)}.`
    : base;
}

/**
 * Scheduler sweep: opt-in retention for disabled sources plus a bounded
 * incremental reclaim pass. Returns whether a maintenance action started.
 */
export async function runDocumentIndexLifecycleSweep(): Promise<boolean> {
  if (runtime.status.running) return false;
  const settings = getDocumentIndexLifecycleSettings();
  const inventory = await getDocumentIndexInventory();
  const expired = disabledSourcesPastRetention(settings.purge_disabled_after_days).length > 0;
  const reclaimable = inventory.auto_vacuum === "incremental" && inventory.free_bytes > 0;
  if (!expired && !reclaimable) return false;
  return startDocumentIndexMaintenance({
    action: "lifecycle",
    retentionDays: settings.purge_disabled_after_days,
  }).started;
}

/** Await the in-flight maintenance action, if any. Test seam. */
export function waitForDocumentIndexMaintenance(): Promise<void> {
  return runtime.current ?? Promise.resolve();
}

/** Test seam. */
export function __resetDocumentIndexLifecycleForTests(): void {
  runtime.status = emptyStatus();
  runtime.current = null;
  runtime.autoVacuumOverride = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
