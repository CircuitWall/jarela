import { NextRequest, NextResponse } from "next/server";
import {
  listAgentConfigs,
  upsertAgentConfig,
  generateAgentId,
} from "@/lib/stores/agent-configs";
import type { MbtiType } from "@/lib/agents/adaptive-persona-presets";

function toResponse(a: ReturnType<typeof listAgentConfigs>[number]) {
  return {
    id: a.id,
    name: a.name,
    icon: a.icon,
    identity: a.identity,
    instructions: a.instructions,
    tools: JSON.parse(a.tools) as string[],
    model_config_name: a.model_config_name,
    is_default: !!a.is_default,
    history_limit: a.history_limit,
    history_window_hours: a.history_window_hours,
    never_reply: !!a.never_reply,
    adaptive_persona_enabled: !!a.adaptive_persona_enabled,
    adaptive_persona_strength: a.adaptive_persona_strength,
    adaptive_empathy: a.adaptive_empathy,
    adaptive_expressiveness: a.adaptive_expressiveness,
    adaptive_verbosity: a.adaptive_verbosity,
    adaptive_mbti: a.adaptive_mbti,
    voice_enabled: !!a.voice_enabled,
    voice_model: a.voice_model,
    voice_name: a.voice_name,
    voice_stt_model: a.voice_stt_model,
    voice_auto_speak: !!a.voice_auto_speak,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function GET() {
  return NextResponse.json(listAgentConfigs().map(toResponse));
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
    return NextResponse.json({ error: "name is required" }, { status: 400 });
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

  return NextResponse.json(toResponse(row), { status: 201 });
}
