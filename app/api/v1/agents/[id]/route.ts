import { NextRequest, NextResponse } from "next/server";
import {
  getAgentConfig,
  upsertAgentConfig,
  deleteAgentConfig,
} from "@/lib/stores/agent-configs";
import { agentToResponse } from "@/lib/api/serializers";
import { notFoundResponse } from "@/lib/api/responses";
import type { AgentConfigIn } from "@/api/types";
import { toUpdateAgentInput } from "../payload";

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

  const body = await req.json() as Partial<AgentConfigIn>;

  const row = upsertAgentConfig(toUpdateAgentInput(id, body, existing));

  return NextResponse.json(agentToResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const deleted = deleteAgentConfig(id);
  if (!deleted) return notFoundResponse("Agent not found");
  return NextResponse.json({ deleted: true });
}
