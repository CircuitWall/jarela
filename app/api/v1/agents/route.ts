import { NextRequest, NextResponse } from "next/server";
import {
  listAgentConfigs,
  upsertAgentConfig,
  generateAgentId,
} from "@/lib/stores/agent-configs";
import type { MbtiType } from "@/lib/agents/adaptive-persona-presets";
import { agentToResponse } from "@/lib/api/serializers";
import { errorResponse, createdResponse, cachedJson } from "@/lib/api/responses";

export function GET() {
  return cachedJson(listAgentConfigs().map(agentToResponse), 15);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    name: string;
    icon?: string | null;
    identity?: string;
    instructions?: string;
    tools?: string[];
    model_config_name?: string | null;
    is_default?: boolean;
    history_limit?: number;
    history_window_hours?: number;
    never_reply?: boolean;
    adaptive_persona_enabled?: boolean;
    adaptive_persona_strength?: number;
    adaptive_empathy?: number;
    adaptive_expressiveness?: number;
    adaptive_verbosity?: number;
    adaptive_mbti?: string;
    voice_enabled?: boolean;
    voice_model?: string;
    voice_name?: string;
    voice_stt_model?: string;
    voice_auto_speak?: boolean;
  };

  if (!body.name?.trim()) {
    return errorResponse("name is required");
  }

  const row = upsertAgentConfig({
    id: generateAgentId(body.name),
    name: body.name.trim(),
    icon: body.icon ?? null,
    identity: body.identity ?? "",
    instructions: body.instructions ?? "",
    tools: body.tools ?? [],
    model_config_name: body.model_config_name ?? null,
    is_default: body.is_default,
    history_limit: body.history_limit,
    history_window_hours: body.history_window_hours,
    never_reply: body.never_reply,
    adaptive_persona_enabled: body.adaptive_persona_enabled,
    adaptive_persona_strength: body.adaptive_persona_strength,
    adaptive_empathy: body.adaptive_empathy,
    adaptive_expressiveness: body.adaptive_expressiveness,
    adaptive_verbosity: body.adaptive_verbosity,
    adaptive_mbti: body.adaptive_mbti as MbtiType | undefined,
    voice_enabled: body.voice_enabled,
    voice_model: body.voice_model,
    voice_name: body.voice_name,
    voice_stt_model: body.voice_stt_model,
    voice_auto_speak: body.voice_auto_speak,
  });

  return createdResponse(agentToResponse(row));
}
