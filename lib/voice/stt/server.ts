// Server-backed speech recognition for the `whisper` and `gemini` engines
// (ADR-0123). Both go through the same endpoint; only the payload differs —
// Gemini accepts the recorded container as-is, Whisper needs 16 kHz mono PCM16
// WAV because the server has no opus decoder.
import { blobToWhisperWav } from "./audio";
import type { SttEngine } from "./types";
export interface ServerTranscribeOptions {
  agentId: string;
  engine: SttEngine;
  blob: Blob;
}

export async function transcribeOnServer({ agentId, engine, blob }: ServerTranscribeOptions): Promise<string> {
  const audio = engine === "whisper" ? await blobToWhisperWav(blob) : blob;
  const extension = engine === "whisper" ? "wav" : (blob.type || "audio/webm").includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("agent_id", agentId);
  form.append("engine", engine);
  form.append("audio", audio, `voice.${extension}`);
  const res = await fetch("/api/v1/voice/transcribe", { method: "POST", body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { text?: string };
  return typeof body.text === "string" ? body.text : "";
}
