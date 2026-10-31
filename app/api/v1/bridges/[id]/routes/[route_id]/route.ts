import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteRoute, getRoute, updateRoute } from "@/lib/stores/bridges";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { errorMessage } from "@/lib/utils/error";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";
import { bridgeRouteToResponse } from "@/lib/api/serializers";

interface Params { params: Promise<{ id: string; route_id: string }> }

const RouteJidSchema = z.union([z.literal("*"), z.string().trim().min(3)]);

const PatchSchema = z.object({
  remote_jid: RouteJidSchema.optional(),
  agent_id: z.string().trim().min(1).optional(),
  label: z.string().trim().max(120).nullable().optional(),
  silent_mode: z.boolean().optional(),
  respond_to: z.enum(["user", "counterpart"]).optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { route_id } = await params;
  const existing = getRoute(route_id);
  if (!existing) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }
  if (parsed.data.agent_id && !getAgentConfig(parsed.data.agent_id)) {
    return errorResponse(`agent ${parsed.data.agent_id} not found`, 400);
  }

  try {
    const updated = updateRoute(route_id, parsed.data);
    if (!updated) return errorResponse("update failed", 500);
    return NextResponse.json(bridgeRouteToResponse(updated));
  } catch (err) {
    const m = errorMessage(err);
    if (/UNIQUE/.test(m)) {
      const reason = /agent_id/.test(m)
        ? "That agent is already the target of another route."
        : "That chat is already routed.";
      return errorResponse(reason, 409);
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { route_id } = await params;
  const ok = deleteRoute(route_id);
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
}
