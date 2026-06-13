import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteMemory, putMemory } from "@/lib/stores/memory";
import { validateBody } from "@/lib/api/responses";

type Params = { params: Promise<{ namespace: string; key: string }> };

const PutBody = z.object({ value: z.unknown() });

export async function PUT(req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  const r = putMemory(namespace, key, body.value);
  return NextResponse.json({ ...r, value: body.value });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  const deleted = deleteMemory(namespace, key);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
