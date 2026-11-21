// Shared vocabulary for the voice input engines (ADR-0123).
//
// `gemini` keeps the pre-ADR-0123 behavior (multimodal Gemini transcription,
// the default), `browser` uses the Web Speech API in the client, and
// `whisper` runs the hash-pinned tiny ONNX model on the server. The value is
// stored per agent and validated at every API boundary.
export const STT_ENGINES = ["gemini", "browser", "whisper"] as const;

export type SttEngine = (typeof STT_ENGINES)[number];

/** Sample rate Whisper expects; the browser resamples to it before upload. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Preserves the pre-ADR-0123 path for agents that never chose an engine. */
export const DEFAULT_STT_ENGINE: SttEngine = "gemini";

export function isSttEngine(value: unknown): value is SttEngine {
  return typeof value === "string" && (STT_ENGINES as readonly string[]).includes(value);
}

export function normalizeSttEngine(value: unknown): SttEngine {
  return isSttEngine(value) ? value : DEFAULT_STT_ENGINE;
}

export function sttEngineLabel(engine: SttEngine): string {
  if (engine === "browser") return "Browser speech recognition";
  if (engine === "whisper") return "Whisper tiny (local)";
  return "Gemini transcription";
}

/** One in-flight capture. `stop` resolves with the final transcript. */
export interface SttSession {
  readonly engine: SttEngine;
  stop(): Promise<string>;
  cancel(): void;
}

export interface SttStartOptions {
  /** Language hint, e.g. `en-US`. */
  lang?: string;
  /** Live, not-yet-final text. Only the browser engine produces these. */
  onPartial?: (text: string) => void;
  /**
   * Fired when the engine ends the turn on its own — silence, Safari's
   * non-continuous mode, or an asynchronous error — so capture state cannot
   * latch. Not fired for `stop()` or `cancel()`.
   */
  onEnd?: (outcome: { text: string; error: string | null }) => void;
}
