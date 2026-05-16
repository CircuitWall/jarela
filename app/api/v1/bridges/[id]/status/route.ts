import { NextRequest, NextResponse } from "next/server";
import { getBridge } from "@/lib/stores/bridges";
import { getBridgeRuntimeStatus, isBridgeRunning } from "@/lib/bridges/runtime";

interface Params { params: Promise<{ id: string }> }

/**
 * Live status (polled by the UI while pairing or to render the connection
 * pill). Prefers the in-memory runtime state (carries the freshest QR data
 * URL) and falls back to the persisted row when the adapter isn't running
 * yet — e.g. just after server boot but before startBridge has settled.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getBridge(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const live = getBridgeRuntimeStatus(id);
  return NextResponse.json({
    id,
    status: live?.status ?? row.status,
    qr_data_url: live?.qr_data_url ?? row.qr ?? null,
    last_error: live?.error ?? row.last_error,
    paired_id: live?.paired_id ?? row.paired_id,
    running: isBridgeRunning(id),
    enabled: row.enabled === 1,
  });
}
