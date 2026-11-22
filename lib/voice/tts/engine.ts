import type { SttEngine } from "@/lib/voice/stt/types";

// Spoken replies follow the selected speech engine instead of always using
// Gemini: browser/Whisper dictation stays vendor-free and speaks through the
// browser's built-in voices, while Gemini input keeps the Gemini TTS voice.
// Whisper is recognition-only, so it maps to browser voices.
export type ReplyTtsEngine = "gemini" | "browser";

export function resolveReplyTtsEngine(sttEngine: SttEngine | null | undefined): ReplyTtsEngine {
  return sttEngine === "browser" || sttEngine === "whisper" ? "browser" : "gemini";
}

export function replyTtsEngineLabel(engine: ReplyTtsEngine): string {
  return engine === "browser" ? "Browser voices" : "Gemini TTS";
}
