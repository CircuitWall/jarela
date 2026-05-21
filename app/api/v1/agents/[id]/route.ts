import { NextRequest, NextResponse } from "next/server";
import {
  getAgentConfig,
  upsertAgentConfig,
  deleteAgentConfig,
} from "@/lib/stores/agent-configs";
import type { MbtiType } from "@/lib/agents/adaptive-persona-presets";

type Params = { params: Promise<{ id: string }> };

function toResponse(row: ReturnType<typeof getAgentConfig>) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    identity: row.identity,
    instructions: row.instructions,
    tools: JSON.parse(row.tools) as string[],
    model_config_name: row.model_config_name,
    is_default: !!row.is_default,
    history_limit: row.history_limit,
    history_window_hours: row.history_window_hours,
    never_reply: !!row.never_reply,
    adaptive_persona_enabled: !!row.adaptive_persona_enabled,
    adaptive_persona_strength: row.adaptive_persona_strength,
    adaptive_empathy: row.adaptive_empathy,
    adaptive_expressiveness: row.adaptive_expressiveness,
    adaptive_verbosity: row.adaptive_verbosity,
    adaptive_mbti: row.adaptive_mbti,
    voice_enabled: !!row.voice_enabled,
    voice_model: row.voice_model,
    voice_name: row.voice_name,
    voice_stt_model: row.voice_stt_model,
    voice_auto_speak: !!row.voice_auto_speak,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getAgentConfig(id);
  if (!row) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(toResponse(row));
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getAgentConfig(id);
  if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

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
    tools: body.tools ?? (JSON.parse(existing.tools) as string[]),
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

  return NextResponse.json(toResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const deleted = deleteAgentConfig(id);
  if (!deleted) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
