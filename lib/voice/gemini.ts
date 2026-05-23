// Gemini voice helpers — TTS via the *-preview-tts models and STT by
// feeding inline audio bytes to a multimodal Gemini model. Both call the
// native REST API (the OpenAI-compat proxy doesn't expose AUDIO modality
// or inline_data parts). API key is resolved from the "google" integration,
// same source as lib/tools/generate_image.ts.

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { getConfig } from "@/lib/env/config";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new Error(`timeout after ${ms}ms`)), ms).unref?.();
  return c.signal;
}

export function resolveGoogleApiKey(): string | null {
  const raw = getIntegrationRaw("google");
  const fromStore = raw?.api_key?.trim();
  if (fromStore) return fromStore;
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim() || null;
}

interface InlineData {
  mimeType?: string;
  mime_type?: string;
  data?: string;
}
interface GeminiPart {
  text?: string;
  inlineData?: InlineData;
  inline_data?: InlineData;
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string };
}

/**
 * Synthesize speech with Gemini TTS. Gemini returns PCM L16 (raw 16-bit
 * little-endian, 24 kHz mono); we wrap it with a WAV header so any
 * <audio> element can play it.
 *
 * Style/tone is steered by prepending a natural-language instruction to
 * the spoken text (Gemini's recommended pattern), e.g. style="Say warmly
 * and slowly" produces "Say warmly and slowly: <text>". For multi-speaker
 * scenes, pass `speakers` with up to 2 entries and write the text as
 * `Name: line ...` per turn — Gemini will switch voices accordingly.
 */
export async function geminiTts(opts: {
  apiKey: string;
  model: string;
  voiceName: string;
  text: string;
  style?: string;
  speakers?: Array<{ name: string; voiceName: string }>;
}): Promise<{ wav: Buffer; mime: "audio/wav" }> {
  const url = `${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const style = opts.style?.trim();
  const spoken = style ? `${style.replace(/:\s*$/, "")}: ${opts.text}` : opts.text;
  const speakers = (opts.speakers ?? []).filter((s) => s.name && s.voiceName).slice(0, 2);
  const speechConfig: Record<string, unknown> =
    speakers.length >= 2
      ? {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: speakers.map((s) => ({
              speaker: s.name,
              voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voiceName } },
            })),
          },
        }
      : {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: opts.voiceName },
          },
        };
  const body = {
    contents: [{ role: "user", parts: [{ text: spoken }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(getConfig().voiceTimeoutMs),
  });
  const json = (await res.json()) as GeminiResponse;
  if (!res.ok) {
    throw new Error(`Gemini TTS ${res.status}: ${json.error?.message ?? "request failed"}`);
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    const data = inline?.data;
    const mime = inline?.mimeType ?? inline?.mime_type ?? "";
    if (data) {
      const pcm = Buffer.from(data, "base64");
      const rate = parseSampleRate(mime) ?? 24000;
      return { wav: pcmToWav(pcm, rate, 1, 16), mime: "audio/wav" };
    }
  }
  const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
  throw new Error(text ? `Gemini TTS returned no audio: ${text}` : "Gemini TTS returned no audio");
}

/**
 * Transcribe audio via a Gemini multimodal model. Returns the verbatim
 * transcript, preserving the speaker's original language (including code-
 * switched English/Chinese).
 */
export async function geminiStt(opts: {
  apiKey: string;
  model: string;
  audio: Buffer;
  mimeType: string;
}): Promise<{ text: string }> {
  const url = `${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const body = {
    contents: [{
      role: "user",
      parts: [
        {
          text:
            "Transcribe the following audio verbatim. Preserve the speaker's " +
            "original language, including mixed English and Chinese. Output ONLY " +
            "the transcript text — no quotes, no commentary, no language tags.",
        },
        { inline_data: { mime_type: opts.mimeType, data: opts.audio.toString("base64") } },
      ],
    }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(getConfig().voiceTimeoutMs),
  });
  const json = (await res.json()) as GeminiResponse;
  if (!res.ok) {
    throw new Error(`Gemini STT ${res.status}: ${json.error?.message ?? "request failed"}`);
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text).filter(Boolean).join("").trim();
  if (!text) throw new Error("Gemini STT returned no transcript");
  return { text };
}

// `audio/L16;codec=pcm;rate=24000` → 24000
function parseSampleRate(mime: string): number | null {
  const m = /rate=(\d+)/i.exec(mime);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Build a RIFF/WAVE header for raw PCM. Standard 16-bit, mono unless told
// otherwise. No fancy chunks — just enough to satisfy browser audio.
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// Re-export the client-safe constants for callers that already import from
// this module on the server side.
export { GEMINI_VOICES, GEMINI_TTS_MODELS, GEMINI_STT_MODELS } from "./constants";
