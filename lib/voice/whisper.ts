// Whisper input engine (ADR-0123).
//
// Runs `Xenova/whisper-tiny` (quantized ONNX) through the same on-demand
// `@huggingface/transformers` runtime the local embedding model uses, from
// the hash-pinned copy in the data directory. Audio arrives as 16 kHz mono
// PCM WAV decoded in the browser, so the server never needs ffmpeg or a
// webm/opus decoder.
import { requireRuntimePackage } from "@/lib/dependencies/runtime-package";
import { withBlockingWorkAsync } from "@/lib/diagnostics/event-loop";
import { WHISPER_MODEL_REPOSITORY } from "./whisper-model-assets.mjs";
import { requireWhisperModelRoot } from "./whisper-model";
import { WHISPER_SAMPLE_RATE } from "./stt/types";

export { WHISPER_SAMPLE_RATE };

interface WhisperOutput {
  text?: string;
}

type WhisperPipeline = (
  audio: Float32Array,
  options: { task: "transcribe"; language?: string; chunk_length_s: number; stride_length_s: number },
) => Promise<WhisperOutput | WhisperOutput[]>;

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

const globals = globalThis as typeof globalThis & {
  __jarelaWhisperPipeline?: Promise<WhisperPipeline>;
};

async function getWhisperPipeline(): Promise<WhisperPipeline> {
  if (globals.__jarelaWhisperPipeline) return globals.__jarelaWhisperPipeline;
  const loading = (async () => {
    // Resolve the on-demand runtime before touching the model: without it a
    // download can never produce a transcript, so it must not be started.
    const transformers = requireRuntimePackage<{
      env: { localModelPath: string; allowRemoteModels: boolean; allowLocalModels: boolean };
      pipeline: (task: string, model: string, options: { dtype: string }) => Promise<unknown>;
    }>("@huggingface/transformers", "Whisper voice input");
    // Throws (and starts the download) until the model is installed.
    const modelRoot = requireWhisperModelRoot();
    const { env, pipeline } = transformers;
    env.localModelPath = modelRoot;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    return await pipeline("automatic-speech-recognition", WHISPER_MODEL_REPOSITORY, {
      dtype: "q8",
    }) as unknown as WhisperPipeline;
  })();
  globals.__jarelaWhisperPipeline = loading;
  loading.catch(() => {
    if (globals.__jarelaWhisperPipeline === loading) globals.__jarelaWhisperPipeline = undefined;
  });
  return loading;
}

/**
 * Decode a PCM WAV buffer into mono float samples.
 *
 * The browser encoder only ever produces 16-bit PCM mono, so anything else is
 * rejected rather than silently misread as noise.
 */
export function decodeWav(buf: Buffer): DecodedWav {
  if (buf.length < 44) throw new Error("audio is not a valid WAV file");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("audio is not a valid WAV file");
  }
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > buf.length) break;
      format = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new Error("WAV file has no fmt chunk");
  if (!data) throw new Error("WAV file has no data chunk");
  if (format.audioFormat !== 1) throw new Error(`unsupported WAV encoding ${format.audioFormat}; PCM only`);
  if (format.channels !== 1) throw new Error(`expected mono audio, got ${format.channels} channels`);
  if (format.bitsPerSample !== 16) throw new Error(`expected 16-bit audio, got ${format.bitsPerSample}-bit`);
  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2) / 0x8000;
  }
  return { samples, sampleRate: format.sampleRate, channels: format.channels };
}

export interface WhisperTranscribeOptions {
  /** WAV audio, 16 kHz mono PCM16. */
  wav: Buffer;
  /** BCP-47-ish language hint understood by Whisper ("en", "de", …). */
  language?: string;
}

/** Transcribe a 16 kHz mono WAV clip. Blank clips return an empty string. */
export async function whisperTranscribe({ wav, language }: WhisperTranscribeOptions): Promise<string> {
  const { samples, sampleRate } = decodeWav(wav);
  if (sampleRate !== WHISPER_SAMPLE_RATE) {
    throw new Error(`expected ${WHISPER_SAMPLE_RATE} Hz audio, got ${sampleRate} Hz`);
  }
  if (samples.length === 0) return "";
  const transcribe = await getWhisperPipeline();
  const output = await withBlockingWorkAsync("whisper-transcribe", () => transcribe(samples, {
    task: "transcribe",
    ...(language ? { language } : {}),
    chunk_length_s: 30,
    stride_length_s: 5,
  }));
  const text = Array.isArray(output) ? output.map((part) => part.text ?? "").join(" ") : output.text ?? "";
  return text.trim();
}
