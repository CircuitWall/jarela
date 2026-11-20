import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "jarela-spill-gc-"));
process.env.JARELA_DB_DIR = TMP_ROOT;

const { closeDb, getDb } = await import("@/lib/db");
const { closeReadPool } = await import("@/lib/db/read-pool");
const { FILES_DIR } = await import("@/lib/files");
const { collectFileRefNames, removeFilesNoLongerReferenced, runSpillFileGc } = await import("./spill-gc");

afterAll(async () => {
  await closeReadPool();
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("collectFileRefNames", () => {
  it("finds message refs and nested tool result refs", () => {
    const names = collectFileRefNames([
      { type: "image_ref", name: "image.png" },
      { payload: JSON.stringify({ result_ref: { name: "tool.json" } }) },
      "generated: ![x](/api/v1/files/generated-image.png)",
      { type: "text", text: "hello" },
    ]);
    expect([...names].sort()).toEqual(["generated-image.png", "image.png", "tool.json"]);
  });

  it("collects managed metadata refs but ignores external filesystem paths", () => {
    const names = collectFileRefNames({
      attachment_handling: {
        references: [
          { type: "file_reference", storage: "jarela", ref: "managed.txt" },
          { type: "file_reference", storage: "filesystem", ref: "C:\\Users\\me\\outside.txt" },
        ],
      },
    });
    expect([...names]).toEqual(["managed.txt"]);
  });
});

describe("runSpillFileGc", () => {
  it("deletes only old unreferenced files", async () => {
    const suffix = randomUUID();
    const oldUnreferenced = `${createHash("sha256").update(`old-${suffix}`).digest("hex")}.txt`;
    const oldReferenced = `${createHash("sha256").update(`kept-${suffix}`).digest("hex")}.txt`;
    const freshUnreferenced = `${createHash("sha256").update(`fresh-${suffix}`).digest("hex")}.txt`;
    await writeFile(join(FILES_DIR, oldUnreferenced), "old");
    await writeFile(join(FILES_DIR, oldReferenced), "kept");
    await writeFile(join(FILES_DIR, freshUnreferenced), "fresh");

    const stale = new Date(Date.now() - 120_000);
    await utimes(join(FILES_DIR, oldUnreferenced), stale, stale);
    await utimes(join(FILES_DIR, oldReferenced), stale, stale);

    const threadId = randomUUID();
    const msgId = randomUUID();
    const now = new Date().toISOString();
    getDb().prepare("INSERT INTO threads (thread_id,agent_id,title,created_at,updated_at,message_count) VALUES (?,?,?,?,?,?)")
      .run(threadId, "agent", null, now, now, 1);
    getDb().prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events,category,metadata) VALUES (?,?,?,?,?,?,?,?)")
      .run(
        msgId,
        threadId,
        "assistant",
        "The assistant interpreted the attachment.",
        now,
        null,
        null,
        JSON.stringify({
          attachment_handling: {
            references: [
              { type: "file_reference", storage: "jarela", ref: oldReferenced },
              { type: "file_reference", storage: "filesystem", ref: oldUnreferenced },
            ],
          },
        }),
      );

    const result = await runSpillFileGc({ retentionMs: 60_000, now: Date.now() });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(FILES_DIR, oldUnreferenced))).toBe(false);
    expect(existsSync(join(FILES_DIR, oldReferenced))).toBe(true);
    expect(existsSync(join(FILES_DIR, freshUnreferenced))).toBe(true);
  });

  it("deletes nothing when the reference scan fails", async () => {
    const pool = await import("@/lib/db/read-pool");
    const spy = vi.spyOn(pool, "readAppRows").mockRejectedValueOnce(new Error("pool offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const name = `${createHash("sha256").update(`fail-${randomUUID()}`).digest("hex")}.txt`;
    await writeFile(join(FILES_DIR, name), "old");
    const stale = new Date(Date.now() - 120_000);
    await utimes(join(FILES_DIR, name), stale, stale);

    const result = await runSpillFileGc({ retentionMs: 60_000, now: Date.now() });
    expect(result).toEqual({ scanned: 0, referenced: 0, removed: 0, removed_bytes: 0 });
    expect(existsSync(join(FILES_DIR, name))).toBe(true);
    spy.mockRestore();
  });
});

function seedThread(): string {
  const threadId = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO threads (thread_id,agent_id,title,created_at,updated_at,message_count) VALUES (?,?,?,?,?,?)")
    .run(threadId, `agent-${threadId}`, null, now, now, 1);
  return threadId;
}

function seedThreadMessage(threadId: string, parts: { content: string; metadata?: string | null; tool_events?: string | null }): void {
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events,category,metadata) VALUES (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), threadId, "assistant", parts.content, now, parts.tool_events ?? null, null, parts.metadata ?? null);
}

describe("removeFilesNoLongerReferenced", () => {
  it("deletes only the file no stored text mentions, however the name appears", async () => {
    const suffix = randomUUID();
    const orphan = `${createHash("sha256").update(`orphan-${suffix}`).digest("hex")}.txt`;
    const inProse = `${createHash("sha256").update(`prose-${suffix}`).digest("hex")}.txt`;
    const inMemory = `${createHash("sha256").update(`memory-${suffix}`).digest("hex")}.txt`;
    const inJson = `${createHash("sha256").update(`json-${suffix}`).digest("hex")}.txt`;
    for (const name of [orphan, inProse, inMemory, inJson]) await writeFile(join(FILES_DIR, name), "x");

    // A bare mention with no JSON and no /api/v1/files link must still count:
    // that is what the per-name LIKE scan matched before this check.
    const threadId = seedThread();
    seedThreadMessage(threadId, { content: `the attachment ${inProse} was discussed` });
    seedThreadMessage(threadId, { content: "tool output", metadata: JSON.stringify({ result_ref: { name: inJson } }) });
    const now = new Date().toISOString();
    getDb()
      .prepare("INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)")
      .run("test", `k-${suffix}`, `recalled ${inMemory}`, now, now);

    const removed = await removeFilesNoLongerReferenced([orphan, inProse, inMemory, inJson]);
    expect(removed).toBe(1);
    expect(existsSync(join(FILES_DIR, orphan))).toBe(false);
    expect(existsSync(join(FILES_DIR, inProse))).toBe(true);
    expect(existsSync(join(FILES_DIR, inMemory))).toBe(true);
    expect(existsSync(join(FILES_DIR, inJson))).toBe(true);
  });

  it("keeps every file when encrypted memory cannot be decrypted", async () => {
    const name = `${createHash("sha256").update(`locked-${randomUUID()}`).digest("hex")}.txt`;
    await writeFile(join(FILES_DIR, name), "x");
    const now = new Date().toISOString();
    const key = `locked-${randomUUID()}`;
    getDb()
      .prepare("INSERT INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)")
      .run("test", key, "enc:v1:AAAA", now, now);
    try {
      expect(await removeFilesNoLongerReferenced([name])).toBe(0);
      expect(existsSync(join(FILES_DIR, name))).toBe(true);
    } finally {
      getDb().prepare("DELETE FROM memory_store WHERE key=?").run(key);
    }
  });
});