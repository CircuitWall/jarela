import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-message-embedding-jobs-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const {
  claimMessageEmbeddingJobs,
  completeMessageEmbeddingJob,
  enqueueMessageEmbeddingJob,
  failMessageEmbeddingJob,
  nextMessageEmbeddingDelayMs,
} = await import("./message-embedding-jobs");

function addMessage(messageId: string, content: string): void {
  const timestamp = new Date().toISOString();
  getDb().prepare(
    "INSERT INTO messages (msg_id,thread_id,role,content,created_at) VALUES (?,?,?,?,?)",
  ).run(messageId, "thread-1", "user", content, timestamp);
}

beforeEach(() => {
  getDb().exec("DELETE FROM message_embedding_jobs; DELETE FROM messages;");
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("message embedding jobs", () => {
  it("claims pending work and marks successful embeddings complete", () => {
    addMessage("msg-1", "searchable message content");
    enqueueMessageEmbeddingJob("msg-1", "searchable message content");

    const [job] = claimMessageEmbeddingJobs();
    expect(job).toMatchObject({ message_id: "msg-1", attempts: 1, content: "searchable message content" });
    const cached = completeMessageEmbeddingJob(job, [0.1, 0.2], "test-provider:test-model");

    expect(cached).toMatchObject({ message_id: "msg-1", thread_id: "thread-1" });
    expect(getDb().prepare("SELECT embedding FROM messages WHERE msg_id='msg-1'").get()).toEqual({ embedding: "[0.1,0.2]" });
    expect(getDb().prepare("SELECT state, model_signature FROM message_embedding_jobs WHERE message_id='msg-1'").get()).toEqual({
      state: "done",
      model_signature: "test-provider:test-model",
    });
  });

  it("requeues work when the transcript text changes while embedding is in flight", () => {
    addMessage("msg-2", "original transcript content");
    enqueueMessageEmbeddingJob("msg-2", "original transcript content");
    const [job] = claimMessageEmbeddingJobs();
    getDb().prepare("UPDATE messages SET content='revised transcript content' WHERE msg_id='msg-2'").run();

    expect(completeMessageEmbeddingJob(job, [0.3], "test-provider:test-model")).toBeNull();
    expect(getDb().prepare("SELECT source_hash, state FROM message_embedding_jobs WHERE message_id='msg-2'").get()).toEqual({
      source_hash: enqueueMessageEmbeddingJob("msg-2", "revised transcript content"),
      state: "pending",
    });
  });

  it("releases retryable failures with backoff and retains terminal failures", () => {
    addMessage("msg-3", "retryable transcript content");
    enqueueMessageEmbeddingJob("msg-3", "retryable transcript content");
    const [retryable] = claimMessageEmbeddingJobs();
    failMessageEmbeddingJob(retryable, "provider offline", false);
    expect(getDb().prepare("SELECT state FROM message_embedding_jobs WHERE message_id='msg-3'").get()).toEqual({ state: "pending" });

    const future = Date.now() + 60_000;
    const [retried] = claimMessageEmbeddingJobs(1, 5 * 60_000, future);
    failMessageEmbeddingJob(retried, "invalid input", true, "test-provider:test-model");
    expect(getDb().prepare("SELECT state, attempted_signature, last_error FROM message_embedding_jobs WHERE message_id='msg-3'").get()).toEqual({
      state: "failed",
      attempted_signature: "test-provider:test-model",
      last_error: "invalid input",
    });
  });

  it("reports when durable retry work becomes eligible", () => {
    addMessage("msg-retry", "retryable transcript content");
    enqueueMessageEmbeddingJob("msg-retry", "retryable transcript content");
    const currentTime = Date.now();
    const [job] = claimMessageEmbeddingJobs(1, 5 * 60_000, currentTime);
    failMessageEmbeddingJob(job, "provider offline", false);

    expect(nextMessageEmbeddingDelayMs(currentTime)).toBeGreaterThan(0);
  });

  it("cascades pending work when its source message is deleted", () => {
    addMessage("msg-4", "message pending embedding");
    enqueueMessageEmbeddingJob("msg-4", "message pending embedding");
    getDb().prepare("DELETE FROM messages WHERE msg_id='msg-4'").run();

    expect(getDb().prepare("SELECT message_id FROM message_embedding_jobs WHERE message_id='msg-4'").get()).toBeUndefined();
  });
});
