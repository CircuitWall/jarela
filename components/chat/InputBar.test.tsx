// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBar } from "./InputBar";

const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("owns recording teardown and hands back only the trimmed transcript", async () => {
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
      start() {
        this.state = "recording";
        this.ondataavailable?.({ data: new Blob(["voice"]) });
      }
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop recording" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(onVoiceTranscript).toHaveBeenCalledWith("spoken turn"));
    expect(stopTrack).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });
});
