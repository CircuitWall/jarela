import { NextRequest, NextResponse } from "next/server";
import { getBridge } from "@/lib/stores/bridges";
import { getBridgeModule } from "@/lib/bridges/registry";
import { repairBridge } from "@/lib/bridges/runtime";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

interface Params { params: Promise<{ id: string }> }

/**
 * Wipe Baileys auth state on disk and start the adapter fresh — the next
 * `connection.update` event will carry a QR string the UI renders to let the
 * user re-link the WhatsApp account.
 *
 * Returns 202 immediately; pairing progress lives at GET /bridges/[id]/status.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getBridge(id);
  if (!row) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  if (!getBridgeModule(row.kind)?.pairing) {
    return errorResponse("bridge kind does not support pairing", 400);
  }
  void repairBridge(id).catch((err) => {
    console.error(`[bridge ${id}] re-pair failed:`, err);
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
