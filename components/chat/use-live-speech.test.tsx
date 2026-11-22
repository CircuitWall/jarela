// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@/api/types";

const mocks = vi.hoisted(() => {
  const queue = { push: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
  const state: {
    handlers: { onStart(): void; onDrain(): void; onError(message: string): void } | null;
    engine: string;
    agentId: string | null;
  } = { handlers: null, engine: "", agentId: null };
  return { queue, state };
});

vi.mock("./live-speech", () => ({
  createLiveSpeechQueue: (options: { engine: string; agentId: string | null; handlers: unknown }) => {
    mocks.state.handlers = options.handlers as typeof mocks.state.handlers;
    mocks.state.engine = options.engine;
    mocks.state.agentId = options.agentId;
    return mocks.queue;
  },
}));

import { _resetAutoSpeak, requestLiveSpeech } from "./auto-speak";
import { _resetLiveSpeech, useLiveSpeech } from "./use-live-speech";
import { _resetVoiceConversation, consumeVoiceListen, getVoiceConversationState } from "./voice-conversation";

const AGENT = { id: "agent-1", voice_enabled: true, voice_stt_engine: "browser" } as AgentConfig;

function Probe({ content, streaming }: { content: string; streaming: boolean }) {
  useLiveSpeech({ content, streaming, agentConfig: AGENT });
  return null;
}

beforeEach(() => {
  _resetAutoSpeak();
  _resetLiveSpeech();
  _resetVoiceConversation();
  vi.clearAllMocks();
  mocks.state.handlers = null;
});

describe("useLiveSpeech", () => {
  it("stays silent for a turn that did not arrive as speech", () => {
    render(<Probe content="A typed reply. Second sentence." streaming />);
    expect(mocks.queue.push).not.toHaveBeenCalled();
  });

  it("speaks from the first complete sentence while the reply streams", () => {
    requestLiveSpeech();
    const view = render(<Probe content="Hello there. " streaming />);

    expect(mocks.state.engine).toBe("browser");
    expect(mocks.state.agentId).toBe("agent-1");
    expect(mocks.queue.push).toHaveBeenCalledWith("Hello there.");
    expect(mocks.queue.finish).not.toHaveBeenCalled();

    view.rerender(<Probe content="Hello there. The build is green. And" streaming />);
    expect(mocks.queue.push).toHaveBeenLastCalledWith("The build is green.");

    view.rerender(<Probe content="Hello there. The build is green. And done." streaming={false} />);
    expect(mocks.queue.push).toHaveBeenLastCalledWith("And done.");
    expect(mocks.queue.finish).toHaveBeenCalledTimes(1);
  });

  it("joins the conversation loop and hands listening back when the clip ends", () => {
    requestLiveSpeech();
    render(<Probe content="Spoken reply." streaming />);

    act(() => mocks.state.handlers?.onStart());
    expect(getVoiceConversationState().speaking).toBe(true);

    act(() => mocks.state.handlers?.onDrain());
    expect(getVoiceConversationState().speaking).toBe(false);
    expect(consumeVoiceListen()).toBe(true);
  });

  it("reads the last unfinished sentence when the live block clears", () => {
    requestLiveSpeech();
    const view = render(<Probe content="Only a tail" streaming />);
    expect(mocks.queue.push).not.toHaveBeenCalled();

    view.rerender(<Probe content="" streaming={false} />);
    expect(mocks.queue.push).toHaveBeenCalledWith("Only a tail");
    expect(mocks.queue.finish).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh reader when a steer replaces the reply", () => {
    requestLiveSpeech();
    const view = render(<Probe content="First answer. " streaming />);
    expect(mocks.queue.push).toHaveBeenCalledWith("First answer.");

    view.rerender(<Probe content="Different answer. " streaming />);
    expect(mocks.queue.cancel).toHaveBeenCalled();
    expect(mocks.queue.push).toHaveBeenLastCalledWith("Different answer.");
  });
});
