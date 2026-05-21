// generate_voice: synthesize spoken audio from text using Gemini TTS and
// return a /api/v1/files/ URL the assistant should embed in its reply.
//
// Supports natural-language style steering ("Say cheerfully:") and an
// optional 2-speaker mode for dialogues. The chat renderer recognises the
// <audio controls> tag (sanitizeSchema allows it explicitly).
//
// API key resolution piggy-backs on the existing "google" integration —
// same source as generate_image.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "crypto";
import { writeBinaryFile } from "@/lib/files";
import { geminiTts, resolveGoogleApiKey } from "@/lib/voice/gemini";
import { GEMINI_TTS_MODELS, GEMINI_VOICES } from "@/lib/voice/constants";

const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Kore";
const MAX_TEXT_CHARS = 5000;

const SpeakerSchema = z.object({
  name: z.string().min(1).describe("Speaker label that appears in the text, e.g. 'Alice'."),
  voice_name: z.string().min(1).describe("Gemini prebuilt voice for this speaker (e.g. 'Kore', 'Puck')."),
});

export const generateVoiceTool = tool(
  async ({ text, voice_name, model, style, speakers, autoplay }) => {
    const trimmed = (text ?? "").trim();
    if (!trimmed) throw new Error("text is required and must be non-empty");
    if (trimmed.length > MAX_TEXT_CHARS) {
      throw new Error(`text exceeds ${MAX_TEXT_CHARS} character cap`);
    }

    const apiKey = resolveGoogleApiKey();
    if (!apiKey) {
      throw new Error(
        'Google API key not configured. Open Integrations and set "Google AI (Gemini + Imagen)", or set GEMINI_API_KEY in the environment.',
      );
    }

    const m = (model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const voice = (voice_name ?? DEFAULT_VOICE).trim() || DEFAULT_VOICE;
    const speakerList = (speakers ?? [])
      .map((s) => ({ name: s.name.trim(), voiceName: s.voice_name.trim() }))
      .filter((s) => s.name && s.voiceName);

    const { wav } = await geminiTts({
      apiKey,
      model: m,
      voiceName: voice,
      text: trimmed,
      style: style?.trim() || undefined,
      speakers: speakerList.length >= 2 ? speakerList : undefined,
    });

    const name = `voice-${randomUUID()}.wav`;
    writeBinaryFile(name, wav);
    const baseUrl = `/api/v1/files/${name}`;
    const url = autoplay ? `${baseUrl}?autoplay=1` : baseUrl;

    return JSON.stringify({
      model: m,
      voice_name: voice,
      style: style ?? null,
      speakers: speakerList.length >= 2 ? speakerList : null,
      autoplay: !!autoplay,
      bytes: wav.length,
      url,
      markdown: `[\u{1F50A} Voice clip${autoplay ? " (auto)" : ""}](${url})`,
      hint: "Embed the `markdown` field verbatim in your reply on its own line; the chat renderer will turn that link into an inline audio player. Set autoplay=true only when the user asked you to speak (e.g. they sent voice input or explicitly asked you to talk). Do NOT wrap it in a code fence and do NOT transcribe the audio in the reply \u2014 the player is the answer.",
    });
  },
  {
    name: "generate_voice",
    description:
      "Synthesize speech with Google's Gemini TTS and return a local audio URL the assistant must embed via the returned `markdown` (an <audio controls> tag). Use the `style` arg to steer tone/emotion (e.g. 'Say cheerfully', 'Whisper conspiratorially'). For dialogues, pass up to 2 `speakers` and prefix each line in `text` with `Name: ` — Gemini switches voices automatically. Requires the Google integration (api_key).",
    schema: z.object({
      text: z
        .string()
        .min(1)
        .describe(
          "The text to speak. For dialogues, write one turn per line as `Name: line` matching the `speakers` labels. Max 5000 chars.",
        ),
      voice_name: z
        .enum(GEMINI_VOICES.map((v) => v.id) as [string, ...string[]])
        .optional()
        .describe(`Prebuilt Gemini voice. Defaults to ${DEFAULT_VOICE}.`),
      model: z
        .enum(GEMINI_TTS_MODELS.map((m) => m.id) as [string, ...string[]])
        .optional()
        .describe(`Gemini TTS model. Defaults to ${DEFAULT_MODEL}.`),
      style: z
        .string()
        .optional()
        .describe(
          "Natural-language style instruction prepended to the text, e.g. 'Say warmly and slowly', 'Whisper conspiratorially', 'In a tired, defeated voice', 'Read like a 1940s radio host'.",
        ),
      speakers: z
        .array(SpeakerSchema)
        .min(2)
        .max(2)
        .optional()
        .describe(
          "Optional 2-speaker setup for dialogues. When set, `voice_name` is ignored and each line in `text` should start with one of the speaker `name`s followed by ': '.",
        ),
      autoplay: z
        .boolean()
        .optional()
        .describe(
          "If true, the audio plays automatically when the message renders. Use this ONLY when the user clearly wants you to speak back (they sent voice input, said 'say it out loud', etc.). Default false \u2014 user clicks play.",
        ),
    }),
  },
);
