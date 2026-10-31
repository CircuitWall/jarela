import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  events: [] as string[],
  queued: null as Promise<unknown> | null,
  active: { abort: new AbortController() },
  prepare: vi.fn(),
  persistUser: vi.fn(),
  persistAssistant: vi.fn(),
  collect: vi.fn(),
  broadcast: vi.fn(),
  finish: vi.fn(),
  update: vi.fn(),
  notify: vi.fn(),
  drain: vi.fn(),
  continuation: vi.fn(),
}));

vi.mock("@/lib/agents/run-thread", () => ({
  prepareThreadRun: state.prepare,
  persistThreadRunUserMessage: state.persistUser,
  persistAssistantMessage: state.persistAssistant,
  snapshotThreadModelConfigName: () => "pinned",
  withInterruptMarker: (text: string) => `${text}\ninterrupted`,
  RunThreadError: class RunThreadError extends Error {},
}));
vi.mock("@/lib/agents/run-queue", () => ({
  enqueueThreadRun: (_id: string, _source: string, runner: () => Promise<unknown>) => {
    state.queued = runner();
    return { position: 0, result: state.queued };
  },
  QueueFullError: class QueueFullError extends Error {},
}));
vi.mock("@/lib/agents/run-registry", () => ({
  startRun: () => {
    state.events.push("start");
    return state.active;
  },
  broadcast: state.broadcast,
  finishRun: state.finish,
  drainSteering: state.drain,
}));
vi.mock("@/lib/agents/stream-collector", () => ({ collectStream: state.collect }));
vi.mock("@/lib/agents/agent-turn", () => ({ runAgentTurn: state.continuation }));
vi.mock("@/lib/agents/turn-profile", () => ({ resolveTurnProfile: () => ({ include_hot: true }) }));
vi.mock("@/lib/agents/model-router", () => ({ finalizeRouteDecision: () => null }));
vi.mock("@/lib/stores/threads", () => ({
  getThread: () => ({ agent_id: "agent" }),
  updateMessageContent: state.update,
  getThreadMessageBySeq: () => ({ transcript_status: "in_progress" }),
}));
vi.mock("@/lib/agents/transcript-draft", () => ({
  createAssistantTranscriptDraft: () => ({ msg_id: "draft", seq: 2, visibleContent: "" }),
  persistAssistantDraftChunk: () => undefined,
}));
vi.mock("@/lib/notifications/bus", () => ({ publish: state.notify }));
vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ perfTelemetryEnabled: false }) }));
vi.mock("@/lib/tools/support/result-refs", () => ({ parseToolResultReferenceEnvelope: () => null }));

const { POST } = await import("./route");

function submit() {
  return POST(new NextRequest("http://localhost/api/v1/threads/thread/run", {
    method: "POST",
    body: JSON.stringify({ message: "Request" }),
  }), { params: Promise.resolve({ thread_id: "thread" }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  state.events = [];
  state.queued = null;
  state.active = { abort: new AbortController() };
  state.persistUser.mockImplementation(async (request) => {
    state.events.push("durable");
    request._onTranscriptUserPersisted();
    return { userMessageId: "user", storedContent: "Request", idleMsBefore: 42 };
  });
  state.update.mockReturnValue({ msg_id: "draft" });
  state.prepare.mockResolvedValue({ stream: [], route_decision: null });
  state.collect.mockResolvedValue({
    assistantContent: "Answer", terminal: "done", usedTools: [], toolEvents: [],
  });
  state.drain.mockReturnValue([]);
  state.continuation.mockResolvedValue({});
});

it("admits a durable user row and draft before starting preparation, preserving pinned context", async () => {
  const response = await submit();
  await state.queued;
  expect(response.status).toBe(202);
  expect(state.events).toEqual(["durable", "start"]);
  expect(state.prepare).toHaveBeenCalledWith(expect.objectContaining({
    _user_message_persisted: true,
    _pinned_model_config_name: "pinned",
    _idle_ms_before_user: 42,
  }));
  expect(state.update.mock.invocationCallOrder[0]).toBeLessThan(state.prepare.mock.invocationCallOrder[0]);
  expect(state.persistAssistant.mock.invocationCallOrder[0]).toBeLessThan(state.finish.mock.invocationCallOrder[0]);
  expect(state.finish).toHaveBeenCalledWith(state.active, "done");
});

it("does not execute or register a run when transcript admission fails", async () => {
  state.persistUser.mockRejectedValue(new Error("storage unavailable"));
  const response = await submit();
  await state.queued;
  expect(response.status).toBe(500);
  expect(state.events).toEqual([]);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.finish).not.toHaveBeenCalled();
});

it("marks the draft failed and closes the registry on preparation failure without collecting", async () => {
  state.prepare.mockRejectedValue(new Error("configuration unavailable"));
  expect((await submit()).status).toBe(202);
  await state.queued;
  expect(state.collect).not.toHaveBeenCalled();
  expect(state.update).toHaveBeenLastCalledWith("draft", "", expect.objectContaining({
    transcriptStatus: "failed", category: "run_error",
  }));
  expect(state.broadcast).toHaveBeenLastCalledWith(state.active, expect.objectContaining({ type: "error" }));
  expect(state.finish).toHaveBeenCalledExactlyOnceWith(state.active, "error");
});

it("reports persistence failure before registry completion and does not drain steering", async () => {
  state.persistAssistant.mockImplementation(() => { throw new Error("write failed"); });
  await submit();
  await state.queued;
  expect(state.update).toHaveBeenLastCalledWith("draft", "", expect.objectContaining({
    transcriptStatus: "failed",
  }));
  expect(state.broadcast).toHaveBeenLastCalledWith(state.active, {
    type: "error", data: { message: "persist failed: write failed", code: "persist_error" },
  });
  expect(state.finish).toHaveBeenCalledExactlyOnceWith(state.active, "error");
  expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  expect(state.drain).not.toHaveBeenCalled();
});

it("queues undelivered steering only after successful persistence", async () => {
  state.drain.mockReturnValue(["Late instruction"]);
  await submit();
  await state.queued;
  expect(state.persistAssistant.mock.invocationCallOrder[0]).toBeLessThan(state.drain.mock.invocationCallOrder[0]);
  expect(state.continuation).toHaveBeenCalledWith(expect.objectContaining({
    message: "Late instruction", skip_persist_user_message: true,
    history_append_message: expect.stringContaining("Late instruction"),
  }));
});

it("persists an interruption without delivering signals or reviving cancelled steering", async () => {
  state.prepare.mockResolvedValue({ stream: [], signal_delivery: { signals: [{ id: "signal" }] } });
  state.collect.mockResolvedValue({
    assistantContent: "Partial", terminal: "error", aborted: true, usedTools: [], toolEvents: [],
  });
  await submit();
  await state.queued;
  expect(state.persistAssistant.mock.calls[0][1]).toBe("Partial\ninterrupted");
  expect(state.persistAssistant.mock.calls[0][10]).toBeUndefined();
  expect(state.persistAssistant.mock.calls[0][11]).toMatchObject({ transcriptStatus: "interrupted" });
  expect(state.drain).not.toHaveBeenCalled();
});
