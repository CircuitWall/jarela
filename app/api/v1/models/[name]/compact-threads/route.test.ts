import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-compact-threads-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const capturedTranscripts: string[] = [];

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({}),
}));
vi.mock("@/lib/agents/conversation-summary", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agents/conversation-summary")>(
    "@/lib/agents/conversation-summary",
  );
  return {
    ...actual,
    summarizeTranscript: async (_provider: unknown, _modelId: string, _params: unknown, transcript: string) => {
      capturedTranscripts.push(transcript);
      return "a summary";
    },
  };
});

const { closeDb, getDb } = await import("@/lib/db");
const { createThread, addMessage, getThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { POST } = await import("./route");

beforeEach(() => {
  capturedTranscripts.length = 0;
  getDb().exec("DELETE FROM threads");
  getDb().exec("DELETE FROM messages");
  getDb().exec("DELETE FROM agent_configs");
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function postRequest(name: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/models/${name}/compact-threads`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/models/[name]/compact-threads", () => {
  it("summarizes only foreground messages — run_error markers and automation-channel rows must not leak into the cached warm summary", async () => {
    upsertModelConfig("small-model", "mock", "mock-1", {}, true);
    upsertAgentConfig({
      id: "agent-compact-1",
      name: "Compact Agent",
      identity: "helper",
      instructions: "",
      tools: [],
      model_config_name: "small-model",
    });
    const thread = createThread("agent-compact-1");

    addMessage(thread.thread_id, "user", "genuine chat message one");
    addMessage(thread.thread_id, "assistant", "genuine chat reply one");
    addMessage(thread.thread_id, "assistant", "400 API_KEY_INVALID", undefined, "run_error");
    addMessage(thread.thread_id, "assistant", "scheduled task fired", undefined, "scheduled_task");
    // Trailing messages kept hot (not summarized) per keep_last=1.
    addMessage(thread.thread_id, "user", "the most recent message, stays hot");

    const res = await POST(
      postRequest("small-model", { using: { provider: "mock", model_id: "mock-1" }, keep_last: 1 }),
      { params: Promise.resolve({ name: "small-model" }) },
    );
    const json = await res.json();

    expect(json.compacted).toBe(1);
    expect(capturedTranscripts).toHaveLength(1);
    const transcript = capturedTranscripts[0];
    expect(transcript).toContain("genuine chat message one");
    expect(transcript).toContain("genuine chat reply one");
    expect(transcript).not.toContain("API_KEY_INVALID");
    expect(transcript).not.toContain("scheduled task fired");
  });

  it("wraps the committed summary as foreground-scoped, matching what it actually summarized", async () => {
    upsertModelConfig("small-model-2", "mock", "mock-1", {}, true);
    upsertAgentConfig({
      id: "agent-compact-2",
      name: "Compact Agent 2",
      identity: "helper",
      instructions: "",
      tools: [],
      model_config_name: "small-model-2",
    });
    const thread = createThread("agent-compact-2");
    addMessage(thread.thread_id, "user", "older message");
    addMessage(thread.thread_id, "assistant", "older reply");
    addMessage(thread.thread_id, "user", "recent message");

    await POST(
      postRequest("small-model-2", { using: { provider: "mock", model_id: "mock-1" }, keep_last: 1 }),
      { params: Promise.resolve({ name: "small-model-2" }) },
    );

    const updated = getThread(thread.thread_id);
    expect(updated?.warm_summary).toContain("<!-- jarela:warm-scope=foreground -->");
  });
});
