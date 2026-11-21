// POST /api/v1/voice/transcribe
// FormData: agent_id=<id>, engine?=<gemini|browser|whisper>, audio=<Blob>
//
// One endpoint for every server-side speech-recognition engine (ADR-0123):
//   * gemini  — inline audio bytes to a multimodal Gemini model (the original
//               behaviour, and the default when the form omits `engine`);
//   * whisper — 16 kHz mono PCM WAV transcribed by the local tiny ONNX model.
// The `browser` engine never reaches this route: the Web Speech API runs in
// the client. The agent must have voice_enabled=1 either way.
import { NextRequest, NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { RuntimePackageUnavailableError } from "@/lib/dependencies/runtime-package";
import { geminiStt, resolveGoogleApiKey } from "@/lib/voice/gemini";
import { normalizeSttEngine } from "@/lib/voice/stt/types";
import { whisperTranscribe } from "@/lib/voice/whisper";
import {
  WhisperModelNotReadyError,
  getWhisperModelStatus,
} from "@/lib/voice/whisper-model";
import { errorJson, errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — Gemini inline_data upper bound
const ALLOWED_MIME = new Set([
  "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg",
  "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
  "audio/flac",
]);
// Whisper runs on decoded PCM, so only WAV is accepted for that engine.
const WHISPER_MIME = new Set(["audio/wav", "audio/x-wav"]);

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse("expected multipart/form-data", 400);
  }
  const agentId = String(form.get("agent_id") ?? "").trim();
  const audio = form.get("audio");
  if (!agentId) return errorResponse("agent_id is required", 400);
  if (!(audio instanceof Blob)) {
    return errorResponse("audio file is required", 400);
  }
  if (audio.size === 0) {
    return errorResponse("audio is empty", 400);
  }
  if (audio.size > MAX_BYTES) {
    return errorResponse(`audio exceeds ${MAX_BYTES} bytes`, 400);
  }

  const agent = getAgentConfig(agentId);
  if (!agent) return errorResponse(NOT_FOUND_ERRORS.AGENT_LEGACY, 404);
  if (!agent.voice_enabled) {
    return errorResponse("voice is not enabled for this agent", 400);
  }

  // The client sends the resolved engine; the agent's stored engine is the
  // fallback so older clients keep working unchanged.
  const requested = form.get("engine");
  if (requested !== null && normalizeSttEngine(requested) !== requested) {
    return errorResponse(`unsupported voice engine: ${String(requested)}`, 400);
  }
  const engine = normalizeSttEngine(requested ?? agent.voice_stt_engine);
  if (engine === "browser") {
    return errorResponse("the browser engine runs in the client and cannot be transcribed server-side", 400);
  }

  // Strip codec parameters (`audio/webm;codecs=opus` → `audio/webm`) before
  // matching the allow-list — but pass the full type to Gemini, which can
  // parse the codec hint.
  const fullType = audio.type || "audio/webm";
  const baseType = fullType.split(";")[0].trim().toLowerCase();
  if (engine === "whisper" ? !WHISPER_MIME.has(baseType) : !ALLOWED_MIME.has(baseType)) {
    return errorResponse(
      engine === "whisper"
        ? `whisper needs 16 kHz mono WAV audio, got: ${fullType}`
        : `unsupported audio type: ${fullType}`,
      415,
    );
  }

  const buf = Buffer.from(await audio.arrayBuffer());
  if (engine === "whisper") {
    const language = String(form.get("language") ?? "").trim() || undefined;
    try {
      const text = await whisperTranscribe({ wav: buf, language });
      return NextResponse.json({ text, engine });
    } catch (err) {
      if (err instanceof WhisperModelNotReadyError) {
        return errorJson(
          { error: err.message, engine, model: getWhisperModelStatus() },
          { status: 409 },
        );
      }
      if (err instanceof RuntimePackageUnavailableError) {
        // The message names the exact install step; a model download would
        // not help until the runtime exists.
        return errorResponse(err.message, 503);
      }
      return errorResponse(String(err instanceof Error ? err.message : err), 502);
    }
  }

  const apiKey = resolveGoogleApiKey();
  if (!apiKey) {
    return errorResponse('Google API key not configured. Open Integrations → "Google AI (Gemini + Imagen)".', 400);
  }

  try {
    const { text } = await geminiStt({
      apiKey,
      model: agent.voice_stt_model || "gemini-2.5-flash",
      audio: buf,
      mimeType: fullType,
    });
    return NextResponse.json({ text, engine });
  } catch (err) {
    return errorResponse(String(err instanceof Error ? err.message : err), 502);
  }
}
