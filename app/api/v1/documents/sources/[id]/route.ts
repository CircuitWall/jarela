import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteDocumentSource,
  getDocumentSource,
  getDocumentSourceStats,
  updateDocumentSource,
} from "@/lib/stores/document-sources";
import { notifyTriggerHandlers } from "@/lib/triggers";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  label: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getDocumentSource(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled === 1,
    last_scan_at: row.last_scan_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stats: getDocumentSourceStats(row.id),
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const row = updateDocumentSource(id, parsed.data);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  await notifyTriggerHandlers("source_changed");
  return NextResponse.json({
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled === 1,
    last_scan_at: row.last_scan_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stats: getDocumentSourceStats(row.id),
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteDocumentSource(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  await notifyTriggerHandlers("source_changed");
  return NextResponse.json({ deleted: true });
}
