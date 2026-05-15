import { NextRequest, NextResponse } from "next/server";
import { deleteScheduledTask } from "@/lib/stores/scheduled-tasks";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteScheduledTask(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
