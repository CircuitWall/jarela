import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tempRoot = mkdtempSync(join(tmpdir(), "jarela-hidden-message-route-"));
process.env.JARELA_DB_DIR = tempRoot;

const { createThread, addMessage, getMessages, deleteThread } = await import("@/lib/stores/threads");
const { PATCH } = await import("./route");

const request = (threadId: string, messageId: string, body: unknown) => new NextRequest(
  `http://localhost/api/v1/threads/${threadId}/messages/${messageId}`,
  { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
);

const threads: string[] = [];

afterEach(() => {
  for (const threadId of threads.splice(0)) deleteThread(threadId);
});

afterAll(() => {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

describe("PATCH /api/v1/threads/[thread_id]/messages/[message_id]", () => {
  it("sets hidden_from_chat while preserving other message metadata", async () => {
    const thread = createThread("hidden-message-agent");
    threads.push(thread.thread_id);
    const message = addMessage(thread.thread_id, "user", "old attempt", undefined, null, {
      citations: { checker_model: "checker", claims: [], unverified_links: [] },
    });

    const response = await PATCH(request(thread.thread_id, message.msg_id, { hidden_from_chat: true }), {
      params: Promise.resolve({ thread_id: thread.thread_id, message_id: message.msg_id }),
    });

    expect(response.status).toBe(200);
    const [stored] = getMessages(thread.thread_id);
    expect(JSON.parse(stored.metadata ?? "{}")).toMatchObject({
      hidden_from_chat: true,
      citations: { checker_model: "checker" },
    });
  });

  it("rejects a message that does not belong to the requested thread", async () => {
    const source = createThread("hidden-message-source");
    const target = createThread("hidden-message-target");
    threads.push(source.thread_id, target.thread_id);
    const message = addMessage(source.thread_id, "user", "not in target");

    const response = await PATCH(request(target.thread_id, message.msg_id, { hidden_from_chat: true }), {
      params: Promise.resolve({ thread_id: target.thread_id, message_id: message.msg_id }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects unknown metadata fields", async () => {
    const thread = createThread("hidden-message-schema");
    threads.push(thread.thread_id);
    const message = addMessage(thread.thread_id, "user", "schema");

    const response = await PATCH(request(thread.thread_id, message.msg_id, {
      hidden_from_chat: true,
      citations: {},
    }), {
      params: Promise.resolve({ thread_id: thread.thread_id, message_id: message.msg_id }),
    });

    expect(response.status).toBe(400);
  });
});
