import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBridge, listBridges, type BridgeRow } from "@/lib/stores/bridges";

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

export function GET() {
  return NextResponse.json(listBridges().map(toResponse));
}

const CreateSchema = z.object({
  kind: z.literal("whatsapp"),
  name: z.string().trim().min(1).max(120),
});

export async function POST(req: NextRequest) {
  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  const row = createBridge(parsed.data);
  return NextResponse.json(toResponse(row), { status: 201 });
}
