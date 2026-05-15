import { NextRequest, NextResponse } from "next/server";
import {
  getAgentConfig,
  upsertAgentConfig,
  deleteAgentConfig,
} from "@/lib/stores/agent-configs";

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
  });

  return NextResponse.json(toResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const deleted = deleteAgentConfig(id);
  if (!deleted) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
