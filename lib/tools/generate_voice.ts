// generate_voice: synthesize spoken audio from text using Gemini TTS and
// return a /api/v1/files/ URL the assistant should embed in its reply.
//
// Voice/model are NOT exposed to the agent — they're locked to the
// active agent's per-agent voice config (set by the user in AgentEditor).
// The agent only controls *what* to say, *how* to say it (style), and
// whether to autoplay. Multi-speaker scenes still allow per-speaker
// voice selection because that's compositional, not preference.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { registerLangChainPackage } from "./langchain-package";
import { withStreamDefault } from "./tool-metadata";
import { writeBinaryFile } from "@/lib/files";
import { geminiTts, resolveGoogleApiKey } from "@/lib/voice/gemini";
import { getThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";

const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Kore";
const MAX_TEXT_CHARS = 5000;

const SpeakerSchema = z.object({
  name: z.string().min(1).describe("Speaker label that appears in the text, e.g. 'Alice'."),
  voice_name: z.string().min(1).describe("Gemini prebuilt voice for this speaker (e.g. 'Kore', 'Puck')."),
});

function resolveAgentVoice(config?: RunnableConfig): { model: string; voice: string } {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return { model: DEFAULT_MODEL, voice: DEFAULT_VOICE };
  const thread = getThread(threadId);
  if (!thread?.agent_id) return { model: DEFAULT_MODEL, voice: DEFAULT_VOICE };
  const agent = getAgentConfig(thread.agent_id);
  return {
    model: agent?.voice_model?.trim() || DEFAULT_MODEL,
    voice: agent?.voice_name?.trim() || DEFAULT_VOICE,
  };
}

export const generateVoiceTool = withStreamDefault(tool(
  async ({ text, style, speakers, autoplay }, config) => {
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

    const { model, voice } = resolveAgentVoice(config);
    const speakerList = (speakers ?? [])
      .map((s) => ({ name: s.name.trim(), voiceName: s.voice_name.trim() }))
      .filter((s) => s.name && s.voiceName);

    const { wav } = await geminiTts({
      apiKey,
      model,
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
      "Synthesize speech with Google's Gemini TTS using the agent's configured voice, and return a local audio URL the assistant must embed via the returned `markdown`. Use the `style` arg to steer tone/emotion (e.g. 'Say cheerfully', 'Whisper conspiratorially'). For dialogues, pass up to 2 `speakers` (with explicit voice names per speaker) and prefix each line in `text` with `Name: `. Requires the Google integration (api_key). The voice and model are picked by the user in the agent's settings and cannot be overridden here.",
    schema: z.object({
      text: z
        .string()
        .min(1)
        .describe(
          "The text to speak. For dialogues, write one turn per line as `Name: line` matching the `speakers` labels. Max 5000 chars.",
        ),
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
          "Optional 2-speaker setup for dialogues. When set, the agent's default voice is ignored and each line in `text` should start with one of the speaker `name`s followed by ': '. Use this only when composing a scripted dialogue with two distinct characters.",
        ),
      autoplay: z
        .boolean()
        .optional()
        .describe(
          "If true, the audio plays automatically when the message renders. Use this ONLY when the user clearly wants you to speak back (they sent voice input, said 'say it out loud', etc.). Default false \u2014 user clicks play.",
        ),
    }),
  },
), true);

registerLangChainPackage({
  category: "Voice",
  tools: { execute: [generateVoiceTool] },
});
