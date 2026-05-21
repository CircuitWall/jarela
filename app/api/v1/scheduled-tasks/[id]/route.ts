import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteScheduledTask, updateScheduledTask } from "@/lib/stores/scheduled-tasks";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  prompt: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  kind: z.enum(["once", "cron"]).optional(),
  schedule: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  try {
    const updated = updateScheduledTask(id, parsed.data);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteScheduledTask(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
