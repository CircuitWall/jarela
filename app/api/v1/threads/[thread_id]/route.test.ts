import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "jarela-thread-delete-"));
process.env.JARELA_DB_DIR = TMP_ROOT;

const { getDb } = await import("@/lib/db");
const { FILES_DIR } = await import("@/lib/files");
const { getThread } = await import("@/lib/stores/threads");
const { DELETE } = await import("./route");

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

function seedThread(content: unknown, metadata: unknown = null): string {
  const threadId = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO threads (thread_id,agent_id,title,created_at,updated_at,message_count) VALUES (?,?,?,?,?,?)")
    .run(threadId, `agent-${threadId}`, null, now, now, 1);
  getDb().prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events,category,metadata) VALUES (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), threadId, "user", JSON.stringify(content), now, null, null, metadata ? JSON.stringify(metadata) : null);
  return threadId;
}

function spill(name: string): string {
  writeFileSync(join(FILES_DIR, name), "private bytes");
  return name;
}

const del = (threadId: string) =>
  DELETE(new NextRequest(`http://localhost/api/v1/threads/${threadId}`, { method: "DELETE" }), {
    params: Promise.resolve({ thread_id: threadId }),
  });

describe("DELETE /api/v1/threads/[thread_id] privacy cleanup", () => {
  it("removes attachment files that only the deleted conversation referenced", async () => {
    const photo = spill(`${randomUUID()}.png`);
    const doc = spill(`${randomUUID()}.pdf`);
    const threadId = seedThread(
      [{ type: "text", text: "here is my passport" }, { type: "image_ref", name: photo }],
      { attachment_handling: { references: [{ type: "file_reference", storage: "jarela", ref: doc }] } },
    );

    const res = await del(threadId);
    expect(res.status).toBe(200);
    expect(getThread(threadId)).toBeNull();
    expect(existsSync(join(FILES_DIR, photo))).toBe(false);
    expect(existsSync(join(FILES_DIR, doc))).toBe(false);
  });

  it("keeps files that another conversation still references", async () => {
    const shared = spill(`${randomUUID()}.png`);
    const doomed = seedThread([{ type: "image_ref", name: shared }]);
    const keeper = seedThread([{ type: "text", text: `see /api/v1/files/${shared}` }]);

    expect((await del(doomed)).status).toBe(200);
    expect(existsSync(join(FILES_DIR, shared))).toBe(true);
    expect(getThread(keeper)).not.toBeNull();
  });

  it("returns 404 for an unknown thread and touches no files", async () => {
    const bystander = spill(`${randomUUID()}.png`);
    expect((await del(randomUUID())).status).toBe(404);
    expect(existsSync(join(FILES_DIR, bystander))).toBe(true);
  });

  it("still deletes the thread when an attachment file is already gone", async () => {
    const threadId = seedThread([{ type: "image_ref", name: `${randomUUID()}.png` }]);
    expect((await del(threadId)).status).toBe(200);
    expect(getThread(threadId)).toBeNull();
  });
});
