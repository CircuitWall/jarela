import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRoute, getBridge, listRoutes } from "@/lib/stores/bridges";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { errorMessage } from "@/lib/utils/error";
import { validateBody, errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";
import { bridgeRouteToResponse } from "@/lib/api/serializers";

interface Params { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  return NextResponse.json(listRoutes(id).map(bridgeRouteToResponse));
}

const RouteJidSchema = z.union([z.literal("*"), z.string().trim().min(3)]);

const CreateSchema = z.object({
  remote_jid: RouteJidSchema,
  agent_id: z.string().trim().min(1),
  label: z.string().trim().max(120).optional().nullable(),
  silent_mode: z.boolean().optional(),
  respond_to: z.enum(["user", "counterpart"]).optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);

  const parsed = await validateBody(req, CreateSchema);
  if (parsed instanceof NextResponse) return parsed;
  if (!getAgentConfig(parsed.agent_id)) {
    return errorResponse(`agent ${parsed.agent_id} not found`, 400);
  }

  try {
    const row = createRoute({
      bridge_id: id,
      remote_jid: parsed.remote_jid,
      agent_id: parsed.agent_id,
      label: parsed.label ?? null,
      silent_mode: parsed.silent_mode ?? false,
      respond_to: parsed.respond_to,
    });
    return NextResponse.json(bridgeRouteToResponse(row), { status: 201 });
  } catch (err) {
    const m = errorMessage(err);
    // UNIQUE violations: either (bridge_id, remote_jid) already routed, or
    // the agent is already the target of another route. The error message
    // from SQLite tells us which.
    if (/UNIQUE/.test(m)) {
      const reason = /agent_id/.test(m)
        ? "That agent is already the target of another route. Each agent can serve at most one chat."
        : "That chat is already routed.";
      return errorResponse(reason, 409);
    }
    throw err;
  }
}
