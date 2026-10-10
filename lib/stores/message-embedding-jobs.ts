import { createHash } from "node:crypto";
import { extractEmbeddableText } from "@/lib/memory/record";
import { getDb } from "@/lib/db";
import { withDbTransaction } from "@/lib/db/transaction";

const now = () => new Date().toISOString();

export interface ClaimedMessageEmbeddingJob {
  message_id: string;
  source_hash: string;
  model_signature: string | null;
  attempted_signature: string | null;
  state: "pending" | "processing" | "done" | "failed" | "skipped";
  attempts: number;
  thread_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface EmbeddedMessageCacheEntry {
  message_id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: string;
}

export function messageEmbeddingSourceHash(content: string): string {
  return createHash("sha256").update(extractEmbeddableText(content)).digest("hex");
}

export function enqueueMessageEmbeddingJob(
  messageId: string,
  content: string,
  force = false,
  attemptedSignature?: string | null,
): string {
  const sourceHash = messageEmbeddingSourceHash(content);
  const timestamp = now();
  const empty = extractEmbeddableText(content).trim().length === 0;
  getDb().prepare(
    `INSERT INTO message_embedding_jobs (
       message_id, source_hash, model_signature, attempted_signature, state, attempts, available_at_ms, lease_until_ms,
       last_error, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       source_hash=excluded.source_hash,
       model_signature=CASE WHEN message_embedding_jobs.source_hash != excluded.source_hash THEN NULL ELSE message_embedding_jobs.model_signature END,
       attempted_signature=CASE WHEN message_embedding_jobs.source_hash != excluded.source_hash THEN NULL ELSE COALESCE(excluded.attempted_signature,message_embedding_jobs.attempted_signature) END,
       state=excluded.state,
       attempts=0,
       available_at_ms=excluded.available_at_ms,
       lease_until_ms=NULL,
       last_error=NULL,
       updated_at=excluded.updated_at
     WHERE message_embedding_jobs.source_hash != excluded.source_hash OR ?=1`,
  ).run(messageId, sourceHash, attemptedSignature ?? null, empty ? "skipped" : "pending", Date.now(), timestamp, timestamp, force ? 1 : 0);
  return sourceHash;
}

export function getMessageEmbeddingJob(messageId: string): Pick<ClaimedMessageEmbeddingJob, "model_signature" | "attempted_signature" | "state" | "source_hash"> | null {
  return (getDb().prepare(
    "SELECT model_signature, attempted_signature, state, source_hash FROM message_embedding_jobs WHERE message_id=?",
  ).get(messageId) as Pick<ClaimedMessageEmbeddingJob, "model_signature" | "attempted_signature" | "state" | "source_hash"> | undefined) ?? null;
}

export function claimMessageEmbeddingJobs(
  limit = 16,
  leaseMs = 5 * 60_000,
  nowMs = Date.now(),
): ClaimedMessageEmbeddingJob[] {
  const db = getDb();
  return withDbTransaction(() => {
    const due = db.prepare(
      `SELECT j.message_id, j.source_hash, j.model_signature, j.attempted_signature, j.attempts,
              m.thread_id, m.role, m.content, m.created_at
       FROM message_embedding_jobs j
       JOIN messages m ON m.msg_id=j.message_id
       WHERE (j.state='pending' AND j.available_at_ms<=?)
          OR (j.state='processing' AND j.lease_until_ms<=?)
       ORDER BY m.rowid ASC
       LIMIT ?`,
    ).all(nowMs, nowMs, limit) as unknown as ClaimedMessageEmbeddingJob[];
    const leaseUntil = nowMs + leaseMs;
    const claim = db.prepare(
      `UPDATE message_embedding_jobs
       SET state='processing', attempts=attempts+1, lease_until_ms=?, updated_at=?
       WHERE message_id=? AND source_hash=?
         AND ((state='pending' AND available_at_ms<=?) OR (state='processing' AND lease_until_ms<=?))`,
    );
    return due.filter((job) => Number(claim.run(
      leaseUntil,
      now(),
      job.message_id,
      job.source_hash,
      nowMs,
      nowMs,
    ).changes) > 0).map((job) => ({ ...job, attempts: job.attempts + 1 }));
  });
}

export function nextMessageEmbeddingDelayMs(nowMs = Date.now()): number | null {
  const row = getDb().prepare(
    `SELECT MIN(CASE WHEN state='pending' THEN available_at_ms ELSE lease_until_ms END) AS next_at_ms
     FROM message_embedding_jobs
     WHERE state IN ('pending','processing')`,
  ).get() as { next_at_ms?: number | null } | undefined;
  return typeof row?.next_at_ms === "number" ? Math.max(0, row.next_at_ms - nowMs) : null;
}

export function completeMessageEmbeddingJob(
  job: Pick<ClaimedMessageEmbeddingJob, "message_id" | "source_hash">,
  embedding: number[],
  modelSignature: string,
): EmbeddedMessageCacheEntry | null {
  const db = getDb();
  return withDbTransaction(() => {
    const current = db.prepare(
      `SELECT j.source_hash, j.state, m.thread_id, m.role, m.content, m.created_at
       FROM message_embedding_jobs j
       JOIN messages m ON m.msg_id=j.message_id
       WHERE j.message_id=?`,
    ).get(job.message_id) as (EmbeddedMessageCacheEntry & { source_hash: string; state: string }) | undefined;
    if (!current || current.state !== "processing") return null;
    if (current.source_hash !== job.source_hash || messageEmbeddingSourceHash(current.content) !== job.source_hash) {
      enqueueMessageEmbeddingJob(job.message_id, current.content, true);
      return null;
    }
    const timestamp = now();
    const changed = db.prepare(
      "UPDATE messages SET embedding=? WHERE msg_id=?",
    ).run(JSON.stringify(embedding), job.message_id).changes;
    if (changed === 0) return null;
    const finished = db.prepare(
      `UPDATE message_embedding_jobs
       SET state='done', model_signature=?, attempted_signature=?, lease_until_ms=NULL, last_error=NULL, updated_at=?
       WHERE message_id=? AND source_hash=? AND state='processing'`,
     ).run(modelSignature, modelSignature, timestamp, job.message_id, job.source_hash).changes;
    if (finished === 0) return null;
    return {
      message_id: job.message_id,
      thread_id: current.thread_id,
      role: current.role,
      content: current.content,
      created_at: current.created_at,
    };
  });
}

export function skipMessageEmbeddingJob(job: Pick<ClaimedMessageEmbeddingJob, "message_id" | "source_hash">): void {
  getDb().prepare(
    `UPDATE message_embedding_jobs
     SET state='skipped', lease_until_ms=NULL, last_error=NULL, updated_at=?
     WHERE message_id=? AND source_hash=? AND state='processing'`,
  ).run(now(), job.message_id, job.source_hash);
}

export function failMessageEmbeddingJob(
  job: Pick<ClaimedMessageEmbeddingJob, "message_id" | "source_hash" | "attempts">,
  error: string,
  terminal: boolean,
  attemptedSignature?: string | null,
): void {
  const delayMs = Math.min(60 * 60_000, 1000 * (2 ** Math.min(job.attempts, 12)));
  getDb().prepare(
    `UPDATE message_embedding_jobs
      SET state=?, attempted_signature=COALESCE(?,attempted_signature), available_at_ms=?, lease_until_ms=NULL, last_error=?, updated_at=?
     WHERE message_id=? AND source_hash=? AND state='processing'`,
    ).run(terminal ? "failed" : "pending", attemptedSignature ?? null, Date.now() + delayMs, error.slice(0, 1000), now(), job.message_id, job.source_hash);
  }
