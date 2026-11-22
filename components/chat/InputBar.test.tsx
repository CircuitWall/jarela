// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBar } from "./InputBar";
import {
  _resetVoiceConversation,
  getVoiceConversationState,
  notifyVoiceSpeechEnded,
  notifyVoiceSpeechStarted,
} from "./voice-conversation";

const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetVoiceConversation();
  if (mediaDevicesDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
  else Reflect.deleteProperty(navigator, "mediaDevices");
});

function renderComposer(overrides: Partial<React.ComponentProps<typeof InputBar>> = {}) {
  const props = {
    attachments: [],
    onAttachmentsChange: vi.fn(),
    onSubmit: vi.fn(),
    onQueue: vi.fn(),
    onStop: vi.fn(),
    streaming: false,
    ...overrides,
  };
  const view = render(<InputBar {...props} />);
  return { ...view, props, textbox: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("InputBar local ownership", () => {
  it.each([false, true])("submits and clears local text while streaming=%s", (streaming) => {
    const { textbox, props } = renderComposer({ streaming });
    fireEvent.change(textbox, { target: { value: "next turn" } });
    textbox.style.height = "120px";
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("next turn");
    expect(props.onQueue).not.toHaveBeenCalled();
    expect(textbox.value).toBe("");
    expect(textbox.style.height).toBe("auto");
  });

  it.each(["ctrlKey", "metaKey"])("queues explicitly with %s+Enter", (modifier) => {
    const { textbox, props } = renderComposer({ streaming: true });
    fireEvent.change(textbox, { target: { value: "queued turn" } });
    fireEvent.keyDown(textbox, { key: "Enter", [modifier]: true });
    expect(props.onQueue).toHaveBeenCalledWith("queued turn");
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(textbox.value).toBe("");
  });

  it("keeps Shift+Enter and disabled submissions local", () => {
    const { textbox, props, rerender } = renderComposer();
    fireEvent.change(textbox, { target: { value: "draft" } });
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(textbox.value).toBe("draft");
    rerender(<InputBar {...props} disabled />);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(textbox.value).toBe("draft");
  });

  it("completes slash commands before submitting, and submits an exact command", () => {
    const { textbox, props } = renderComposer();
    fireEvent.change(textbox, { target: { value: "/b" } });
    fireEvent.keyDown(textbox, { key: "Tab" });
    expect(textbox.value).toBe("/btw ");
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: "/new" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("/new");
  });

  it("allows attachment-only turns but ignores an empty composer", () => {
    const { textbox, props, rerender } = renderComposer();
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).not.toHaveBeenCalled();
    rerender(<InputBar {...props} attachments={[{ type: "file", name: "notes.txt", media_type: "text/plain", data: "notes" }]} />);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("");
    expect(props.onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("stops a run without submitting the local draft", () => {
    const { textbox, props } = renderComposer({ streaming: true });
    fireEvent.change(textbox, { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(textbox.value).toBe("keep me");
  });

  it("ends the server capture when the user presses Finish (no Web Audio fallback)", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true, value: { getUserMedia },
    });
    class Recorder {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      stream = stream;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = "recording";
        this.ondataavailable?.({ data: new Blob(["voice"]) });
      }
      pause() { this.state = "paused"; }
      resume() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ text: "  spoken turn  " }),
    }));
    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", onVoiceTranscript });
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel voice input" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));
    await waitFor(() => expect(onVoiceTranscript).toHaveBeenCalledWith("spoken turn"));
    expect(stopTrack).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("auto-pauses and auto-sends from mic-level silence", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true, value: { getUserMedia },
    });
    const pauseSpy = vi.fn();
    class Recorder {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      stream = stream;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = "recording";
        this.ondataavailable?.({ data: new Blob(["voice"]) });
      }
      pause() { pauseSpy(); this.state = "paused"; }
      resume() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.onstop?.(); }
    }
    vi.stubGlobal("MediaRecorder", Recorder);

    const level = { value: 200 };
    class FakeAnalyser {
      fftSize = 1024;
      getByteTimeDomainData(buffer: Uint8Array) { buffer.fill(level.value); }
      connect() { /* noop */ }
      disconnect() { /* noop */ }
    }
    class FakeSource {
      connect() { /* noop */ }
      disconnect() { /* noop */ }
    }
    class FakeAudioContext {
      createMediaStreamSource() { return new FakeSource(); }
      createAnalyser() { return new FakeAnalyser(); }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ text: "server words" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", onVoiceTranscript });
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("button", { name: "Cancel voice input" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish recording" })).toBeNull();

    level.value = 128;
    await act(async () => {
      vi.advanceTimersByTime(1_300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pauseSpy).toHaveBeenCalled();
    expect(onVoiceTranscript).toHaveBeenCalledWith("server words");
    expect(stopTrack).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses the browser engine and auto-sends after transcript inactivity", async () => {
    vi.useFakeTimers();
    class FakeRecognition {
      static instances: FakeRecognition[] = [];
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        FakeRecognition.instances.push(this);
      }
      start() { /* started */ }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    FakeRecognition.instances = [];
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser", onVoiceTranscript });

    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    expect(FakeRecognition.instances).toHaveLength(1);
    const recognition = FakeRecognition.instances[0];
    const interim = Object.assign([{ transcript: "spoken words" }], { isFinal: false });
    act(() => {
      recognition.onresult?.({ resultIndex: 0, results: [interim] });
    });
    expect(screen.getByText("spoken words")).toBeTruthy();
    const final = Object.assign([{ transcript: " spoken words " }], { isFinal: true });
    act(() => {
      recognition.onresult?.({ resultIndex: 0, results: [final] });
    });

    await act(async () => {
      vi.advanceTimersByTime(1_300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onVoiceTranscript).toHaveBeenCalledWith("spoken words");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancels the turn instead of sending it", async () => {
    class FakeRecognition {
      static instances: FakeRecognition[] = [];
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() { FakeRecognition.instances.push(this); }
      start() { /* started */ }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    FakeRecognition.instances = [];
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser", onVoiceTranscript });

    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    const recognition = FakeRecognition.instances[0];
    const interim = Object.assign([{ transcript: "discard me" }], { isFinal: false });
    act(() => {
      recognition.onresult?.({ resultIndex: 0, results: [interim] });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice input" }));
    expect(onVoiceTranscript).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeTruthy();
  });

  it("keeps the transcript and clears capture state when the engine ends on its own", async () => {
    class FakeRecognition {
      static instances: FakeRecognition[] = [];
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        FakeRecognition.instances.push(this);
      }
      start() { /* started */ }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    FakeRecognition.instances = [];
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser", onVoiceTranscript });

    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(FakeRecognition.instances).toHaveLength(1));
    const recognition = FakeRecognition.instances[0];
    const final = Object.assign([{ transcript: "ended by silence" }], { isFinal: true });
    act(() => {
      recognition.onresult?.({ resultIndex: 0, results: [final] });
      // Safari ignores `continuous` and ends the session after one utterance.
      recognition.onend?.();
    });

    await waitFor(() => expect(onVoiceTranscript).toHaveBeenCalledWith("ended by silence"));
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeTruthy();
  });
});

describe("InputBar voice conversation loop", () => {
  function stubRecognition() {
    class FakeRecognition {
      static instances: FakeRecognition[] = [];
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() { FakeRecognition.instances.push(this); }
      start() { /* started */ }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    FakeRecognition.instances = [];
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    return FakeRecognition;
  }

  it("listens again when a spoken reply ends", () => {
    const recognition = stubRecognition();
    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser", onVoiceTranscript });

    act(() => {
      notifyVoiceSpeechStarted("msg-1", vi.fn());
      notifyVoiceSpeechEnded("msg-1");
    });

    expect(recognition.instances).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancel voice input" })).toBeTruthy();
    expect(onVoiceTranscript).not.toHaveBeenCalled();
  });

  it("stops reading and listens when the user presses Stop", () => {
    const recognition = stubRecognition();
    const stop = vi.fn();
    const props = renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser" }).props;

    act(() => {
      notifyVoiceSpeechStarted("msg-1", stop);
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop reading and listen" }));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(props.onStop).not.toHaveBeenCalled();
    expect(recognition.instances).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancel voice input" })).toBeTruthy();
  });

  it("ends the conversation after 5 seconds of silence", async () => {
    vi.useFakeTimers();
    const recognition = stubRecognition();
    const onVoiceTranscript = vi.fn();
    renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser", onVoiceTranscript });

    act(() => {
      notifyVoiceSpeechStarted("msg-1", vi.fn());
      notifyVoiceSpeechEnded("msg-1");
    });
    expect(recognition.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(4_900);
    });
    expect(screen.queryByText("Voice conversation ended after 5 seconds of silence.")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.getByText("Voice conversation ended after 5 seconds of silence.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeTruthy();
    expect(onVoiceTranscript).not.toHaveBeenCalled();
    expect(getVoiceConversationState().active).toBe(false);
  });

  it("does not start listening for a manual play button", () => {
    const recognition = stubRecognition();
    const { textbox } = renderComposer({ voiceEnabled: true, agentId: "agent-1", voiceSttEngine: "browser" });
    fireEvent.change(textbox, { target: { value: "typed turn" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(recognition.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeTruthy();
  });
});
