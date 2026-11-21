// Client-side audio conversion for the Whisper engine (ADR-0123).
//
// The server has no webm/opus decoder (and Jarela does not ship ffmpeg), so
// the browser decodes its own recording and resamples it to the 16 kHz mono
// PCM16 WAV that Whisper expects. `decodeAudioData` resamples to the
// AudioContext's rate, which is why the offline context is created at 16 kHz.
import { WHISPER_SAMPLE_RATE } from "./types";

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext ?? null;
}

export function canDecodeAudioLocally(): boolean {
  return offlineCtor() !== null;
}

/** Encode mono float samples as a 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** Decode any recording the browser can play into 16 kHz mono PCM16 WAV. */
export async function blobToWhisperWav(blob: Blob): Promise<Blob> {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error("This browser cannot decode the recording locally. Choose the Gemini engine in the agent's voice settings.");
  const context = new Ctor(1, 1, WHISPER_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error("Could not decode the recording for local transcription. Choose the Gemini engine in the agent's voice settings.");
  }
  const channels = decoded.numberOfChannels;
  const length = decoded.length;
  const samples = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i += 1) samples[i] += data[i] / channels;
  }
  return encodeWav(samples, decoded.sampleRate);
}
