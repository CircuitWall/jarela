import { NextRequest, NextResponse } from "next/server";
import { deleteMemory, getMemory, putMemory } from "@/lib/stores/memory";

type Params = { params: Promise<{ namespace: string; key: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  const { value } = await req.json() as { value: unknown };
  const r = putMemory(namespace, key, value);
  return NextResponse.json({ ...r, value });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  const deleted = deleteMemory(namespace, key);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
