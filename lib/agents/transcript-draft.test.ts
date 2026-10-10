import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk } from "./base";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-transcript-draft-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { createThread, addMessage, getMessages } = await import("@/lib/stores/threads");
const { createAssistantTranscriptDraft, persistAssistantDraftChunk } = await import("./transcript-draft");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function chunk(type: StreamChunk["type"], data: Record<string, unknown>): StreamChunk {
  return { type, data };
}

describe("assistant transcript draft", () => {
  it("keeps user/draft order and persists visible text and tool events before finalization", () => {
    const thread = createThread("draft-order");
    const user = addMessage(thread.thread_id, "user", "question");
    const draft = createAssistantTranscriptDraft(thread.thread_id);
    persistAssistantDraftChunk(draft, chunk("text_delta", { delta: "Answer." }));
    persistAssistantDraftChunk(draft, chunk("text_delta", { delta: "\n```jarela-references\n[" }));
    persistAssistantDraftChunk(draft, chunk("tool_call", { id: "call-1", name: "web_search", arguments: { query: "q" } }));

    const rows = getMessages(thread.thread_id);
    expect(draft.seq).toBeGreaterThan(user.seq);
    expect(rows[1]).toMatchObject({ transcript_status: "in_progress", content: "Answer." });
    expect(rows[1].tool_events).toContain('"name":"web_search"');
    expect(rows).toHaveLength(2);
  });

  it("replaces the persisted draft when output validation resets streamed text", () => {
    const thread = createThread("draft-reset");
    const draft = createAssistantTranscriptDraft(thread.thread_id);
    persistAssistantDraftChunk(draft, chunk("text_delta", { delta: "incorrect" }));
    persistAssistantDraftChunk(draft, chunk("reset_text", {}));
    persistAssistantDraftChunk(draft, chunk("text_delta", { delta: "corrected" }));

    expect(getMessages(thread.thread_id)[0].content).toBe("corrected");
  });
});