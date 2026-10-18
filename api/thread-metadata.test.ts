import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(), getMessagesPage: vi.fn(), getMessagesAfter: vi.fn(),
  getMessageUsageByIds: vi.fn(), getAgentConfig: vi.fn(),
}));
vi.mock("@/lib/stores/threads", () => ({ ...mocks, deleteThread: vi.fn() }));
vi.mock("@/lib/stores/message-usage", () => ({ getMessageUsageByIds: mocks.getMessageUsageByIds }));
vi.mock("@/lib/stores/agent-configs", () => ({ getAgentConfig: mocks.getAgentConfig }));
vi.mock("@/lib/stores/model-config", () => ({ getModelConfig: vi.fn(), getModelParams: vi.fn() }));
vi.mock("@/lib/agents/warm-summary-background", () => ({
  currentChannelSummaries: () => [], isManualCompactionRunning: () => true,
  pendingCompactionBoundary: () => null, pendingCompactionBoundarySeq: () => 10,
}));
vi.mock("@/lib/agents/conversation-summary", () => ({ parseStoredTopics: () => null }));
vi.mock("@/lib/agents/thread-activity", () => ({ getThreadActivity: () => ({ busy: true }) }));
vi.mock("@/lib/agents/checkpointer", () => ({ getCheckpointer: vi.fn() }));

const { GET } = await import("@/app/api/v1/threads/[thread_id]/route");
function get(query = "") {
  return GET(new NextRequest(`http://localhost/api/v1/threads/t1${query}`),
    { params: Promise.resolve({ thread_id: "t1" }) });
}

describe("thread metadata view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThread.mockReturnValue({ thread_id: "t1", agent_id: "a1", hot_since_seq: 4 });
    mocks.getMessagesPage.mockReturnValue({ messages: [], has_more: true });
    mocks.getMessagesAfter.mockReturnValue([]);
    mocks.getMessageUsageByIds.mockReturnValue(new Map());
    mocks.getAgentConfig.mockReturnValue(null);
  });

  it("returns live metadata without reading messages or usage", async () => {
    const response = await get("?view=metadata");
    const data = await response.json();
    expect(data).toMatchObject({
      thread_id: "t1", hot_since_seq: 4, pending_hot_since_seq: 10,
      manual_compaction_pending: true, activity: { busy: true }, context_window_tokens: 8192,
    });
    expect(data).not.toHaveProperty("messages");
    expect(data).not.toHaveProperty("has_more");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.getMessagesPage).not.toHaveBeenCalled();
    expect(mocks.getMessagesAfter).not.toHaveBeenCalled();
    expect(mocks.getMessageUsageByIds).not.toHaveBeenCalled();
  });

  it("preserves the default paged response and before cursor", async () => {
    const response = await get("?before=42&limit=10");
    expect(await response.json()).toMatchObject({ messages: [], has_more: true });
    expect(mocks.getMessagesPage).toHaveBeenCalledWith("t1", 10, 42);
    expect(mocks.getMessageUsageByIds).toHaveBeenCalledWith([]);
  });

  it("preserves forward message reads", async () => {
    expect(await (await get("?after=42&limit=10")).json()).toMatchObject({ messages: [], has_more: false });
    expect(mocks.getMessagesAfter).toHaveBeenCalledWith("t1", 42, 10);
  });

  it("rejects unknown views", async () => {
    expect((await get("?view=unknown")).status).toBe(400);
    expect(mocks.getMessagesPage).not.toHaveBeenCalled();
  });

  it("preserves missing-thread responses", async () => {
    mocks.getThread.mockReturnValue(null);
    expect((await get("?view=metadata")).status).toBe(404);
  });
});
