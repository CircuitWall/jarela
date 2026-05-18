import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteRoute, getRoute, updateRoute, type BridgeRouteRow } from "@/lib/stores/bridges";
import { getAgentConfig } from "@/lib/stores/agent-configs";

interface Params { params: Promise<{ id: string; route_id: string }> }

function toResponse(r: BridgeRouteRow) {
  return {
    id: r.id,
    bridge_id: r.bridge_id,
    remote_jid: r.remote_jid,
    agent_id: r.agent_id,
    label: r.label,
    silent_mode: r.silent_mode === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const PatchSchema = z.object({
  remote_jid: z.string().trim().min(3).optional(),
  agent_id: z.string().trim().min(1).optional(),
  label: z.string().trim().max(120).nullable().optional(),
  silent_mode: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { route_id } = await params;
  const existing = getRoute(route_id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  if (parsed.data.agent_id && !getAgentConfig(parsed.data.agent_id)) {
    return NextResponse.json({ error: `agent ${parsed.data.agent_id} not found` }, { status: 400 });
  }

  try {
    const updated = updateRoute(route_id, parsed.data);
    if (!updated) return NextResponse.json({ error: "update failed" }, { status: 500 });
    return NextResponse.json(toResponse(updated));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/.test(m)) {
      const reason = /agent_id/.test(m)
        ? "That agent is already the target of another route."
        : "That chat is already routed.";
      return NextResponse.json({ error: reason }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { route_id } = await params;
  const ok = deleteRoute(route_id);
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
}
