import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetVoiceConversation,
  consumeVoiceListen,
  endVoiceConversation,
  getVoiceConversationState,
  notifyVoiceSpeechEnded,
  notifyVoiceSpeechStarted,
  requestVoiceListen,
  stopVoiceSpeech,
  subscribeVoiceConversation,
} from "./voice-conversation";

beforeEach(() => {
  _resetVoiceConversation();
});

describe("voice conversation coordinator", () => {
  it("registers speech and starts listening when the clip ends", () => {
    const listen = vi.fn();
    notifyVoiceSpeechStarted("msg-1", vi.fn());
    expect(getVoiceConversationState()).toEqual({ active: true, speaking: true });

    subscribeVoiceConversation((event) => {
      if (event.type === "listen") {
        listen();
        return true;
      }
      return false;
    });
    notifyVoiceSpeechEnded("msg-1");

    expect(listen).toHaveBeenCalledTimes(1);
    expect(getVoiceConversationState().speaking).toBe(false);
    expect(consumeVoiceListen()).toBe(false);
  });

  it("stops reading and requests listening on Stop", () => {
    const stop = vi.fn();
    notifyVoiceSpeechStarted("msg-1", stop);
    expect(stopVoiceSpeech()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(consumeVoiceListen()).toBe(true);
    expect(getVoiceConversationState().speaking).toBe(false);
  });

  it("parks a listen request until the composer is ready", () => {
    notifyVoiceSpeechStarted("msg-1", vi.fn());
    notifyVoiceSpeechEnded("msg-1");
    expect(consumeVoiceListen()).toBe(true);
    expect(consumeVoiceListen()).toBe(false);
  });

  it("ignores a late end event from a clip that was already stopped", () => {
    notifyVoiceSpeechStarted("msg-1", vi.fn());
    stopVoiceSpeech();
    expect(consumeVoiceListen()).toBe(true);
    notifyVoiceSpeechEnded("msg-1");
    expect(consumeVoiceListen()).toBe(false);
  });

  it("ends the loop on a failed clip", () => {
    const end = vi.fn();
    subscribeVoiceConversation((event) => {
      if (event.type === "end") end();
      return false;
    });
    notifyVoiceSpeechStarted("msg-1", vi.fn());
    endVoiceConversation();
    expect(end).toHaveBeenCalledTimes(1);
    expect(getVoiceConversationState().active).toBe(false);
  });

  it("silences a clip that is still reading when the loop ends", () => {
    const stop = vi.fn();
    notifyVoiceSpeechStarted("msg-1", stop);
    endVoiceConversation();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(consumeVoiceListen()).toBe(false);
  });

  it("does not start listening when nothing is active", () => {
    requestVoiceListen();
    expect(consumeVoiceListen()).toBe(false);
  });
});
