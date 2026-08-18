import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteBridge, getBridge, updateBridge, removeBridgeAuthDir } from "@/lib/stores/bridges";
import { startBridge, stopBridge } from "@/lib/bridges/runtime";
import { bridgeToResponse } from "@/lib/api/serializers";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";

interface Params { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getBridge(id);
  if (!row) return notFoundResponse("not found");
  return NextResponse.json(bridgeToResponse(row));
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  event_subscriptions: z
    .object({
      group_profile_updates: z.boolean().optional(),
      group_participants_updates: z.boolean().optional(),
    })
    .optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getBridge(id);
  if (!existing) return notFoundResponse("not found");

  const parsed = await validateBody(req, PatchSchema);
  if (parsed instanceof NextResponse) return parsed;

  const patch: Parameters<typeof updateBridge>[1] = {};
  if (parsed.name !== undefined) patch.name = parsed.name;
  if (parsed.enabled !== undefined) patch.enabled = parsed.enabled ? 1 : 0;
  if (parsed.event_subscriptions?.group_profile_updates !== undefined) {
    patch.forward_group_profile_updates = parsed.event_subscriptions.group_profile_updates ? 1 : 0;
  }
  if (parsed.event_subscriptions?.group_participants_updates !== undefined) {
    patch.forward_group_participants_updates = parsed.event_subscriptions.group_participants_updates ? 1 : 0;
  }
  const updated = updateBridge(id, patch);
  if (!updated) return errorResponse("update failed", 500);

  // Toggle adapter lifecycle when enabled changed. Fire-and-forget: HTTP
  // shouldn't block on a long Baileys connect; the UI polls /status for
  // live state. Any start error is surfaced via the bridge row's status/
  // last_error fields (set inside runtime.ts).
  if (parsed.enabled !== undefined && parsed.enabled !== (existing.enabled === 1)) {
    if (parsed.enabled) {
      void startBridge(id).catch((err) => {
        console.error(`[bridge ${id}] start on enable failed:`, err);
      });
    } else {
      void stopBridge(id).catch(() => { /* logged inside */ });
    }
  }

  return NextResponse.json(bridgeToResponse(updated));
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
