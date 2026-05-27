import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteWatcher, updateWatcher } from "@/lib/stores/watchers";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  label: z.string().min(1).optional(),
  interval_seconds: z.number().int().min(60).optional(),
  enabled: z.boolean().optional(),
  silent: z.boolean().optional(),
  // ADR-0030: null/empty string clears back to the default directive.
  reaction_prompt: z.string().max(4000).nullable().optional(),
  // ADR-0031: when reaction_kind is provided the reaction is fully replaced
  // (the other branch's fields are forced NULL by the store). When absent,
  // only the matching branch's field is patched. nullable() allows clearing.
  reaction_kind: z.enum(["agent_prompt", "script"]).optional(),
  reaction_script: z.string().nullable().optional(),
  reaction_script_args: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  try {
    const row = updateWatcher(id, parsed.data);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteWatcher(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
