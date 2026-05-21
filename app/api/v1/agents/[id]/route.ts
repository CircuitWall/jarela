import { NextRequest, NextResponse } from "next/server";
import {
  getAgentConfig,
  upsertAgentConfig,
  deleteAgentConfig,
} from "@/lib/stores/agent-configs";
import type { MbtiType } from "@/lib/agents/adaptive-persona-presets";
import { agentToResponse } from "@/lib/api/serializers";
import { notFoundResponse } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getAgentConfig(id);
  if (!row) return notFoundResponse("Agent not found");
  return NextResponse.json(agentToResponse(row));
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getAgentConfig(id);
  if (!existing) return notFoundResponse("Agent not found");

  const body = await req.json() as {
    name?: string;
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

  const row = upsertAgentConfig({
    id,
    name: body.name?.trim() ?? existing.name,
    icon: "icon" in body ? (body.icon ?? null) : existing.icon,
    identity: body.identity ?? existing.identity,
    instructions: body.instructions ?? existing.instructions,
    tools: body.tools ?? parseJsonSafe<string[]>(existing.tools, []),
    model_config_name: "model_config_name" in body ? (body.model_config_name ?? null) : existing.model_config_name,
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

  return NextResponse.json(agentToResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const deleted = deleteAgentConfig(id);
  if (!deleted) return notFoundResponse("Agent not found");
  return NextResponse.json({ deleted: true });
}
