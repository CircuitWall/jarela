import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-voice-transcribe-"));
process.env.JARELA_DB_DIR = tmpRoot;

const hoisted = vi.hoisted(() => {
  class WhisperModelNotReadyError extends Error {
    readonly transient = true;
  }
  return {
    WhisperModelNotReadyError,
    whisperModelState: { state: "ready" as "ready" | "downloading" | "missing" | "failed", totalBytes: 42 },
    transcribeWithWhisper: null as null | (() => Promise<string>),
  };
});

vi.mock("@/lib/voice/gemini", () => ({
  resolveGoogleApiKey: vi.fn(() => null as string | null),
  geminiStt: vi.fn(async () => ({ text: "gemini transcript" })),
}));
vi.mock("@/lib/voice/whisper", () => ({
  whisperTranscribe: vi.fn(async () => "whisper transcript"),
}));
vi.mock("@/lib/voice/whisper-model", () => ({
  WhisperModelNotReadyError: hoisted.WhisperModelNotReadyError,
  getWhisperModelStatus: () => hoisted.whisperModelState,
  startWhisperModelDownload: vi.fn(async () => ""),
}));

const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const gemini = await import("@/lib/voice/gemini");
const whisper = await import("@/lib/voice/whisper");
const { POST } = await import("./route");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  vi.mocked(gemini.resolveGoogleApiKey).mockReturnValue(null);
  vi.mocked(whisper.whisperTranscribe).mockResolvedValue("whisper transcript");
  hoisted.whisperModelState.state = "ready";
  upsertAgentConfig({
    id: "voice-agent",
    name: "Voice",
    identity: "",
    instructions: "",
    tools: [],
    voice_enabled: true,
    voice_stt_engine: "whisper",
  });
});

function wav(size = 8): Blob {
  return new Blob([new Uint8Array(size)], { type: "audio/wav" });
}

function post(fields: { agent_id?: string; engine?: string; audio?: Blob }): NextRequest {
  const form = new FormData();
  if (fields.agent_id !== undefined) form.append("agent_id", fields.agent_id);
  if (fields.engine !== undefined) form.append("engine", fields.engine);
  if (fields.audio) form.append("audio", fields.audio, "voice.wav");
  return new NextRequest("http://localhost/api/v1/voice/transcribe", { method: "POST", body: form });
}

describe("POST /api/v1/voice/transcribe engine dispatch", () => {
  it("uses the agent's stored engine when the form omits one", async () => {
    const res = await POST(post({ agent_id: "voice-agent", audio: wav() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "whisper transcript", engine: "whisper" });
    expect(gemini.geminiStt).not.toHaveBeenCalled();
  });

  it("routes explicit whisper requests through the local model", async () => {
    const res = await POST(post({ agent_id: "voice-agent", engine: "whisper", audio: wav() }));
    expect(res.status).toBe(200);
    expect(whisper.whisperTranscribe).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ text: "whisper transcript", engine: "whisper" });
  });

  it("rejects compressed audio for whisper", async () => {
    const res = await POST(post({
      agent_id: "voice-agent",
      engine: "whisper",
      audio: new Blob([new Uint8Array(4)], { type: "audio/webm" }),
    }));
    expect(res.status).toBe(415);
    expect(whisper.whisperTranscribe).not.toHaveBeenCalled();
  });

  it("reports a transient 409 while the whisper model downloads", async () => {
    vi.mocked(whisper.whisperTranscribe).mockRejectedValueOnce(
      new hoisted.WhisperModelNotReadyError("the Whisper model is downloading"),
    );
    hoisted.whisperModelState.state = "downloading";
    const res = await POST(post({ agent_id: "voice-agent", engine: "whisper", audio: wav() }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; model: { state: string } };
    expect(body.error).toContain("downloading");
    expect(body.model.state).toBe("downloading");
  });

  it("keeps the Gemini path working when a key is configured", async () => {
    vi.mocked(gemini.resolveGoogleApiKey).mockReturnValue("test-key");
    const res = await POST(post({ agent_id: "voice-agent", engine: "gemini", audio: wav() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "gemini transcript", engine: "gemini" });
  });

  it("explains the missing Google key for Gemini requests", async () => {
    const res = await POST(post({ agent_id: "voice-agent", engine: "gemini", audio: wav() }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("Google API key");
  });

  it("rejects unknown and client-only engines", async () => {
    const unknown = await POST(post({ agent_id: "voice-agent", engine: "sphinx", audio: wav() }));
    expect(unknown.status).toBe(400);
    const browser = await POST(post({ agent_id: "voice-agent", engine: "browser", audio: wav() }));
    expect(browser.status).toBe(400);
    expect((await browser.json() as { error: string }).error).toContain("client");
  });

  it("still requires voice to be enabled for the agent", async () => {
    upsertAgentConfig({ id: "quiet-agent", name: "Quiet", identity: "", instructions: "", tools: [], voice_enabled: false });
    const res = await POST(post({ agent_id: "quiet-agent", audio: wav() }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("not enabled");
  });
});
