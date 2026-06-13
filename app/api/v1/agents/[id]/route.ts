/**
 * @public — `GET /api/v1/agents/[id]`, `PATCH /api/v1/agents/[id]`,
 *           `DELETE /api/v1/agents/[id]`
 *
 * Per-agent CRUD on a single config. See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getAgentConfig,
  upsertAgentConfig,
  deleteAgentConfig,
} from "@/lib/stores/agent-configs";
import { agentToResponse } from "@/lib/api/serializers";
import { notFoundResponse, validateBody } from "@/lib/api/responses";
import type { AgentConfigIn } from "@/api/types";
import { toUpdateAgentInput } from "../payload";

type Params = { params: Promise<{ id: string }> };

// Permissive schema — PATCH-style update: all fields optional, additional
// fields pass through. The payload handler controls field-by-field merging.
const UpdateBody = z.looseObject({});

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

  const parsed = await validateBody(req, UpdateBody);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed as Partial<AgentConfigIn>;

  const row = upsertAgentConfig(toUpdateAgentInput(id, body, existing));

  return NextResponse.json(agentToResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const deleted = deleteAgentConfig(id);
  if (!deleted) return notFoundResponse("Agent not found");
  return NextResponse.json({ deleted: true });
}
