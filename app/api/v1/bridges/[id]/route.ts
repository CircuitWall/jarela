import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteBridge, getBridge, updateBridge, removeBridgeAuthDir, type BridgeRow } from "@/lib/stores/bridges";
import { startBridge, stopBridge } from "@/lib/bridges/runtime";

interface Params { params: Promise<{ id: string }> }

function toResponse(r: BridgeRow) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    status: r.status,
    last_error: r.last_error,
    paired_id: r.paired_id,
    enabled: r.enabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getBridge(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(toResponse(row));
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getBridge(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }

  const patch: Parameters<typeof updateBridge>[1] = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled ? 1 : 0;
  const updated = updateBridge(id, patch);
  if (!updated) return NextResponse.json({ error: "update failed" }, { status: 500 });

  // Toggle adapter lifecycle when enabled changed. Fire-and-forget: HTTP
  // shouldn't block on a long Baileys connect; the UI polls /status for
  // live state. Any start error is surfaced via the bridge row's status/
  // last_error fields (set inside runtime.ts).
  if (parsed.data.enabled !== undefined && parsed.data.enabled !== (existing.enabled === 1)) {
    if (parsed.data.enabled) {
      void startBridge(id).catch((err) => {
        console.error(`[bridge ${id}] start on enable failed:`, err);
      });
    } else {
      void stopBridge(id).catch(() => { /* logged inside */ });
    }
  }

  return NextResponse.json(toResponse(updated));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getBridge(id);
  if (!existing) return NextResponse.json({ deleted: false }, { status: 404 });
  try { await stopBridge(id); } catch { /* logged inside */ }
  removeBridgeAuthDir(id);
  const ok = deleteBridge(id);
  return NextResponse.json({ deleted: ok });
}
