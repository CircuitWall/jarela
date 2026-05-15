import { NextRequest, NextResponse } from "next/server";
import {
  listAgentConfigs,
  upsertAgentConfig,
  generateAgentId,
} from "@/lib/stores/agent-configs";

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
  });

  return NextResponse.json(toResponse(row), { status: 201 });
}
