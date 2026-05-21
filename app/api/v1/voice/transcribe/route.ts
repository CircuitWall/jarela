// POST /api/v1/voice/transcribe
// FormData: agent_id=<id>, audio=<Blob>
// Sends the audio bytes inline to a Gemini multimodal model and returns
// { text }. The agent must have voice_enabled=1.
import { NextRequest, NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { geminiStt, resolveGoogleApiKey } from "@/lib/voice/gemini";

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — Gemini inline_data upper bound
const ALLOWED_MIME = new Set([
  "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg",
  "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
  "audio/flac",
]);

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const agentId = String(form.get("agent_id") ?? "").trim();
  const audio = form.get("audio");
  if (!agentId) return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "audio file is required" }, { status: 400 });
  }
  if (audio.size === 0) return NextResponse.json({ error: "audio is empty" }, { status: 400 });
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: `audio exceeds ${MAX_BYTES} bytes` }, { status: 400 });
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

  // Strip codec parameters (`audio/webm;codecs=opus` → `audio/webm`) before
  // matching the allow-list — but pass the full type to Gemini, which can
  // parse the codec hint.
  const fullType = audio.type || "audio/webm";
  const baseType = fullType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(baseType)) {
    return NextResponse.json({ error: `unsupported audio type: ${fullType}` }, { status: 415 });
  }

  const buf = Buffer.from(await audio.arrayBuffer());
  try {
    const { text } = await geminiStt({
      apiKey,
      model: agent.voice_stt_model || "gemini-2.5-flash",
      audio: buf,
      mimeType: fullType,
    });
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502 });
  }
}
