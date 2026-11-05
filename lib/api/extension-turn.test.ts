import { beforeEach, describe, expect, it, vi } from "vitest";

const listThreadsByAgentMock = vi.fn();
const createThreadMock = vi.fn();
const getAgentConfigMock = vi.fn();
const getDefaultAgentConfigMock = vi.fn();
const listAgentConfigsMock = vi.fn();
const publishMock = vi.fn();
const runAgentTurnMock = vi.fn();

vi.mock("@/lib/stores/threads", () => ({
  listThreadsByAgent: (...args: unknown[]) => listThreadsByAgentMock(...args),
  createThread: (...args: unknown[]) => createThreadMock(...args),
}));
vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: (...args: unknown[]) => getAgentConfigMock(...args),
  getDefaultAgentConfig: (...args: unknown[]) => getDefaultAgentConfigMock(...args),
  listAgentConfigs: (...args: unknown[]) => listAgentConfigsMock(...args),
}));
vi.mock("@/lib/notifications/bus", () => ({
  publish: (...args: unknown[]) => publishMock(...args),
}));
vi.mock("@/lib/agents/agent-turn", () => ({
  runAgentTurn: (...args: unknown[]) => runAgentTurnMock(...args),
}));

import { FOREGROUND_PROFILE } from "@/lib/agents/turn-profile";
import { handleExtensionTurn } from "./extension-turn";

function makeReq(body: unknown): Request {
  return new Request("http://localhost:4312/api/v1/extension/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  listThreadsByAgentMock.mockReset();
  createThreadMock.mockReset();
  getAgentConfigMock.mockReset();
  getDefaultAgentConfigMock.mockReset();
  listAgentConfigsMock.mockReset();
  publishMock.mockReset();
  runAgentTurnMock.mockReset();

  getDefaultAgentConfigMock.mockReturnValue({ id: "agent-1", name: "Agent" });
  listAgentConfigsMock.mockReturnValue([{ id: "agent-1", name: "Agent" }]);
  listThreadsByAgentMock.mockReturnValue([{ thread_id: "thread-1", title: "Recent chat" }]);
  runAgentTurnMock.mockResolvedValue({
    assistantContent: "Generated text",
    preview: "Generated text",
    skippedAssistant: false,
  });
});

describe("extension turn context", () => {
  it("uses foreground conversation and memory context for focused-field fills", async () => {
    const res = await handleExtensionTurn("fill", makeReq({
      instruction: "Draft a reply",
      text: "The message to reply to",
      page_context: "Field kind: email reply",
    }));

    expect(res.status).toBe(200);
    expect(runAgentTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      queue_source: "extension",
      context_profile_override: { ...FOREGROUND_PROFILE, force_memory_context: true },
    }));
  });

  it("keeps refinement turns on the isolated one-shot profile", async () => {
    const res = await handleExtensionTurn("refine", makeReq({
      instruction: "Make this clearer",
      text: "Selected text",
    }));

    expect(res.status).toBe(200);
    expect(runAgentTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      queue_source: "extension",
      context_profile_override: undefined,
    }));
  });
});
