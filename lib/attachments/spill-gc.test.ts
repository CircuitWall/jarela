import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "jarela-spill-gc-"));
process.env.JARELA_DB_DIR = TMP_ROOT;

const { closeDb, getDb } = await import("@/lib/db");
const { FILES_DIR } = await import("@/lib/files");
const { collectFileRefNames, runSpillFileGc } = await import("./spill-gc");

afterAll(() => {
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
        JSON.stringify([{ type: "file_ref", name: oldReferenced, media_type: "text/plain", filename: "kept.txt" }]),
        now,
        null,
        null,
        null,
      );

    const result = await runSpillFileGc({ retentionMs: 60_000, now: Date.now() });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(FILES_DIR, oldUnreferenced))).toBe(false);
    expect(existsSync(join(FILES_DIR, oldReferenced))).toBe(true);
    expect(existsSync(join(FILES_DIR, freshUnreferenced))).toBe(true);
  });
});