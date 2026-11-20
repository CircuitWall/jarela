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
import { toUpdateAgentInput, WarmSummaryLimitSchema, UsageProfileSchema } from "../payload";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";
import { ensureNewlyEnabledTools } from "@/lib/dependencies/ensure-tools";
import { parseJsonSafe } from "@/lib/utils/json";

type Params = { params: Promise<{ id: string }> };

// Permissive schema — PATCH-style update: all fields optional, additional
// fields pass through. The payload handler controls field-by-field merging.
const UpdateBody = z.looseObject({ warm_summary_limit: WarmSummaryLimitSchema, usage_profile: UsageProfileSchema });

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getAgentConfig(id);
  if (!row) return notFoundResponse(NOT_FOUND_ERRORS.AGENT);
  return NextResponse.json(agentToResponse(row));
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getAgentConfig(id);
  if (!existing) return notFoundResponse(NOT_FOUND_ERRORS.AGENT);

  const parsed = await validateBody(req, UpdateBody);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed as Partial<AgentConfigIn>;

  const row = upsertAgentConfig(toUpdateAgentInput(id, body, existing));

  // Enabling a tool in the agent editor obtains what it needs (ADR-0122).
  // Fire-and-forget: a 400 MB download must not hold the save request open,
  // and non-allowlisted publishers still go through the approval queue.
  if (Array.isArray(body.tools)) {
    void ensureNewlyEnabledTools(parseJsonSafe<string[]>(existing.tools, []), body.tools);
  }

  return NextResponse.json(agentToResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const deleted = deleteAgentConfig(id);
  if (!deleted) return notFoundResponse(NOT_FOUND_ERRORS.AGENT);
  return NextResponse.json({ deleted: true });
}
