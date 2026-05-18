import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRoute, getBridge, listRoutes, type BridgeRouteRow } from "@/lib/stores/bridges";
import { getAgentConfig } from "@/lib/stores/agent-configs";

interface Params { params: Promise<{ id: string }> }

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

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listRoutes(id).map(toResponse));
}

const CreateSchema = z.object({
  remote_jid: z.string().trim().min(3),
  agent_id: z.string().trim().min(1),
  label: z.string().trim().max(120).optional().nullable(),
  silent_mode: z.boolean().optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  if (!getAgentConfig(parsed.data.agent_id)) {
    return NextResponse.json({ error: `agent ${parsed.data.agent_id} not found` }, { status: 400 });
  }

  try {
    const row = createRoute({
      bridge_id: id,
      remote_jid: parsed.data.remote_jid,
      agent_id: parsed.data.agent_id,
      label: parsed.data.label ?? null,
      silent_mode: parsed.data.silent_mode ?? false,
    });
    return NextResponse.json(toResponse(row), { status: 201 });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // UNIQUE violations: either (bridge_id, remote_jid) already routed, or
    // the agent is already the target of another route. The error message
    // from SQLite tells us which.
    if (/UNIQUE/.test(m)) {
      const reason = /agent_id/.test(m)
        ? "That agent is already the target of another route. Each agent can serve at most one chat."
        : "That chat is already routed.";
      return NextResponse.json({ error: reason }, { status: 409 });
    }
    throw err;
  }
}
