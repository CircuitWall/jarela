import { NextRequest, NextResponse } from "next/server";
import { getBridge } from "@/lib/stores/bridges";
import { isBridgeRunning, listBridgeChats } from "@/lib/bridges/runtime";

interface Params { params: Promise<{ id: string }> }

/**
 * List chats the bridge has observed since connecting. Used by the route
 * editor's chat picker so users don't have to know their WhatsApp JIDs.
 *
 * Empty list is a valid response: it just means the adapter hasn't synced
 * any chats yet (e.g. just paired, hasn't received history sync, or is
 * disconnected). The UI falls back to a manual JID input in that case.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    running: isBridgeRunning(id),
    chats: listBridgeChats(id),
  });
}
