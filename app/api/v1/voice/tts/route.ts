// POST /api/v1/voice/tts
// Body: { agent_id: string, text: string, voice_name?: string, model?: string }
// Resolves voice config from the agent (must have voice_enabled=1) and
// synthesizes audio via Gemini. Returns a WAV body — the client plays it
// with a plain <audio> element. Optional overrides let the assistant try a
// different voice/model without persisting.
import { NextRequest, NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { geminiTts, resolveGoogleApiKey } from "@/lib/voice/gemini";

const MAX_TEXT = 5000;

export async function POST(req: NextRequest) {
  let body: { agent_id?: string; text?: string; voice_name?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const agentId = body.agent_id?.trim();
  const text = body.text?.trim();
  if (!agentId) return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: `text exceeds ${MAX_TEXT} characters` }, { status: 400 });
  }

  const agent = getAgentConfig(agentId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  if (!agent.voice_enabled) {
    return NextResponse.json({ error: "voice is not enabled for this agent" }, { status: 400 });
  }

  const apiKey = resolveGoogleApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Google API key not configured. Open Integrations → "Google AI (Gemini + Imagen)".' },
      { status: 400 },
    );
  }

  const model = (body.model?.trim() || agent.voice_model || "gemini-2.5-flash-preview-tts");
  const voiceName = (body.voice_name?.trim() || agent.voice_name || "Kore");

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
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502 });
  }
}
