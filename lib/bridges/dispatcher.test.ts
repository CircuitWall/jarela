import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeAdapter, InboundMessage } from "./types";

const resolveRouteMock = vi.fn();
const getAgentConfigMock = vi.fn();
const getBridgeMock = vi.fn();
const getOrCreateAgentThreadMock = vi.fn();
const runAgentTurnMock = vi.fn();
const publishNotificationMock = vi.fn();
const formatBridgePromptMock = vi.fn();
const createAutomationActivityMock = vi.fn();
const updateAutomationActivityMock = vi.fn();
const finalizeAutomationActivityMock = vi.fn();

vi.mock("./router", () => ({
  resolveRoute: (...args: unknown[]) => resolveRouteMock(...args),
}));

vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: (...args: unknown[]) => getAgentConfigMock(...args),
}));

vi.mock("@/lib/stores/bridges", () => ({
  getBridge: (...args: unknown[]) => getBridgeMock(...args),
}));

vi.mock("@/lib/stores/threads", () => ({
  getOrCreateAgentThread: (...args: unknown[]) => getOrCreateAgentThreadMock(...args),
}));

vi.mock("@/lib/agents/agent-turn", () => ({
  runAgentTurn: (...args: unknown[]) => runAgentTurnMock(...args),
}));

vi.mock("@/lib/notifications/bus", () => ({
  publish: (...args: unknown[]) => publishNotificationMock(...args),
}));

vi.mock("@/lib/stores/automation-activity", () => ({
  createAutomationActivity: (...args: unknown[]) => createAutomationActivityMock(...args),
  updateAutomationActivity: (...args: unknown[]) => updateAutomationActivityMock(...args),
  finalizeAutomationActivity: (...args: unknown[]) => finalizeAutomationActivityMock(...args),
}));

vi.mock("./message-role", () => ({
  formatBridgePrompt: (...args: unknown[]) => formatBridgePromptMock(...args),
}));

const { handleInboundMessage } = await import("./dispatcher");

function makeAdapter(): BridgeAdapter {
  return {
    bridge_id: "b1",
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    resetAuth: vi.fn(async () => {}),
    onInboundMessage: vi.fn(() => {}),
    onStatusChange: vi.fn(() => {}),
    listChats: vi.fn(() => []),
    refreshChats: vi.fn(async () => {}),
    lookupChat: vi.fn(async () => null),
  };
}

function makeMessage(): InboundMessage {
  return {
    remote_jid: "chat@jid",
    push_name: "Alice",
    chat_name: "Family",
    sender_name: "Bob",
    text: "hello",
    attachments: undefined,
    message_id: "m1",
    is_group: true,
    participant_jid: "bob@jid",
    role: "counterpart",
    event: undefined,
  };
}

describe("handleInboundMessage silent observer mode", () => {
  beforeEach(() => {
    resolveRouteMock.mockReset();
    getAgentConfigMock.mockReset();
    getBridgeMock.mockReset();
    getOrCreateAgentThreadMock.mockReset();
    runAgentTurnMock.mockReset();
    publishNotificationMock.mockReset();
    formatBridgePromptMock.mockReset();
    createAutomationActivityMock.mockReset();
    updateAutomationActivityMock.mockReset();
    finalizeAutomationActivityMock.mockReset();

    resolveRouteMock.mockReturnValue({
      bridge_id: "b1",
      remote_jid: "chat@jid",
      agent_id: "a1",
      silent_mode: 1,
      respond_to: "counterpart",
    });
    getAgentConfigMock.mockReturnValue({ id: "a1" });
    getBridgeMock.mockReturnValue({ id: "b1", kind: "whatsapp", name: "Family bridge" });
    getOrCreateAgentThreadMock.mockReturnValue({ thread_id: "t1" });
    createAutomationActivityMock.mockReturnValue({ msg_id: "activity-1" });
    runAgentTurnMock.mockResolvedValue({
      assistantContent: "NO_REPLY",
      preview: "",
      skippedAssistant: true,
      usage: null,
      aborted: false,
    });
    formatBridgePromptMock.mockReturnValue("BRIDGE_PROMPT");
  });

  it("suppresses non-important NO_REPLY assistant output", async () => {
    const adapter = makeAdapter();
    const msg = makeMessage();

    await handleInboundMessage(adapter, msg);

    expect(runAgentTurnMock).toHaveBeenCalled();
    const reqArg = runAgentTurnMock.mock.calls[0][0] as {
      message: string;
      silent?: boolean;
      queue_lane?: string;
      queue_expires_at?: number;
    };
    expect(reqArg.message).toContain("BRIDGE_PROMPT");
    expect(reqArg.silent).toBe(true);
    expect(reqArg.queue_lane).toBe("background");
    expect(reqArg.queue_expires_at).toBeGreaterThan(Date.now());
    // Silent-mode framing now lives inside formatBridgePrompt (mocked
    // above) — assert the dispatcher forwards the silent flag to it.
    const fmtArg = formatBridgePromptMock.mock.calls[0][0] as { silent?: boolean };
    expect(fmtArg.silent).toBe(true);

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(publishNotificationMock.mock.calls.every(
      ([event]) => (event as { type?: string }).type === "automation_activity",
    )).toBe(true);
    expect(finalizeAutomationActivityMock).toHaveBeenCalledWith(
      "activity-1",
      expect.objectContaining({ disposition: "no_action" }),
    );
  });

  it("keeps important in-app update while still suppressing outbound chat replies", async () => {
    const adapter = makeAdapter();
    const msg = makeMessage();
    runAgentTurnMock.mockResolvedValue({
      assistantContent: "Important: the group announced an urgent schedule change.",
      preview: "Important: the group announced an urgent schedule change.",
      skippedAssistant: false,
      usage: null,
      aborted: false,
    });

    await handleInboundMessage(adapter, msg);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(adapter.sendText).not.toHaveBeenCalled();
    const bridgeEvent = publishNotificationMock.mock.calls
      .map(([event]) => event as { type: string; preview?: string })
      .find((event) => event.type === "bridge_message_received");
    expect(bridgeEvent).toBeDefined();
    const payload = bridgeEvent as { preview: string };
    expect(payload.preview).toContain("Important:");
  });

  it("forwards synthetic event metadata to bridge prompt formatter", async () => {
    const adapter = makeAdapter();
    const msg = makeMessage();
    msg.event = { type: "group_participants_update", subtype: "promote" };

    await handleInboundMessage(adapter, msg);

    const fmtArg = formatBridgePromptMock.mock.calls[0][0] as {
      event?: { type: string; subtype: string };
    };
    expect(fmtArg.event).toEqual({
      type: "group_participants_update",
      subtype: "promote",
    });
  });

  it("prioritizes reply-eligible bridge messages as interactive", async () => {
    resolveRouteMock.mockReturnValue({
      bridge_id: "b1",
      remote_jid: "chat@jid",
      agent_id: "a1",
      silent_mode: 0,
      respond_to: "counterpart",
    });
    runAgentTurnMock.mockResolvedValue({
      assistantContent: "Hello back",
      preview: "Hello back",
      skippedAssistant: false,
      usage: null,
      aborted: false,
    });
    const adapter = makeAdapter();

    await handleInboundMessage(adapter, makeMessage());

    const reqArg = runAgentTurnMock.mock.calls[0][0] as {
      queue_lane?: string;
      queue_expires_at?: number;
      history_bridge_key?: string;
      user_message_metadata?: {
        bridge_conversation?: { key?: string };
      };
    };
    expect(reqArg.queue_lane).toBe("interactive");
    expect(reqArg.queue_expires_at).toBeUndefined();
    expect(reqArg.history_bridge_key).toBe("b1:chat@jid");
    expect(reqArg.user_message_metadata?.bridge_conversation?.key).toBe("b1:chat@jid");
    expect(adapter.sendText).toHaveBeenCalledWith("chat@jid", "Hello back");
    expect(finalizeAutomationActivityMock).toHaveBeenCalledWith(
      "activity-1",
      expect.objectContaining({ disposition: "action" }),
    );
  });

  it("marks terminal failures failed and sends no partial reply", async () => {
    resolveRouteMock.mockReturnValue({
      bridge_id: "b1",
      remote_jid: "chat@jid",
      agent_id: "a1",
      silent_mode: 0,
      respond_to: "counterpart",
    });
    runAgentTurnMock.mockRejectedValue(new Error("Provider connection failed"));
    const adapter = makeAdapter();

    await handleInboundMessage(adapter, makeMessage());

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(finalizeAutomationActivityMock).toHaveBeenCalledWith(
      "activity-1",
      { disposition: "failed", error: "Provider connection failed" },
    );
    expect(publishNotificationMock.mock.calls.some(
      ([event]) => (event as { type?: string }).type === "bridge_message_received",
    )).toBe(false);
  });
});
