import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteDocumentSource,
  getDocumentSource,
  getDocumentSourceStats,
  updateDocumentSource,
} from "@/lib/stores/document-sources";
import { notifyTriggerHandlers } from "@/lib/triggers";
import { notFoundResponse, validateBody } from "@/lib/api/responses";
import { documentSourceToResponse } from "@/lib/api/serializers";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  label: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getDocumentSource(id);
  if (!row) return notFoundResponse();
  return NextResponse.json(documentSourceToResponse(row, getDocumentSourceStats(row.id)));
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const parsed = await validateBody(req, PatchSchema);
  if (parsed instanceof NextResponse) return parsed;
  const row = updateDocumentSource(id, parsed);
  if (!row) return notFoundResponse();
  await notifyTriggerHandlers("source_changed");
  return NextResponse.json(documentSourceToResponse(row, getDocumentSourceStats(row.id)));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteDocumentSource(id);
  if (!ok) return notFoundResponse();
  await notifyTriggerHandlers("source_changed");
  return NextResponse.json({ deleted: true });
}
