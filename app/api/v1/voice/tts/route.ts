// POST /api/v1/voice/tts
// Body: { agent_id: string, text: string, voice_name?: string, model?: string }
// Resolves voice config from the agent (must have voice_enabled=1) and
// synthesizes audio via Gemini. Returns a WAV body — the client plays it
// with a plain <audio> element. Optional overrides let the assistant try a
// different voice/model without persisting.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { geminiTts, resolveGoogleApiKey } from "@/lib/voice/gemini";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";

const MAX_TEXT = 5000;

const BodySchema = z.object({
  agent_id: z.string().min(1, "agent_id is required"),
  text: z.string().min(1, "text is required").max(MAX_TEXT, `text exceeds ${MAX_TEXT} characters`),
  voice_name: z.string().optional(),
  model: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, BodySchema);
  if (parsed instanceof NextResponse) return parsed;
  const agentId = parsed.agent_id.trim();
  const text = parsed.text.trim();

  const agent = getAgentConfig(agentId);
  if (!agent) return notFoundResponse("agent not found");
  if (!agent.voice_enabled) {
    return errorResponse("voice is not enabled for this agent");
  }

  const apiKey = resolveGoogleApiKey();
  if (!apiKey) {
    return errorResponse(
      'Google API key not configured. Open Integrations → "Google AI (Gemini + Imagen)".',
    );
  }

  const model = (parsed.model?.trim() || agent.voice_model || "gemini-2.5-flash-preview-tts");
  const voiceName = (parsed.voice_name?.trim() || agent.voice_name || "Kore");

  try {
    const { wav } = await geminiTts({ apiKey, model, voiceName, text });
    return new NextResponse(new Uint8Array(wav), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(String(err instanceof Error ? err.message : err), 502);
  }
}
