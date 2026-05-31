import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteWatcher, updateWatcher } from "@/lib/stores/watchers";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";

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
  const parsed = await validateBody(req, PatchSchema);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const row = updateWatcher(id, parsed);
    if (!row) return notFoundResponse();
    return NextResponse.json(row);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteWatcher(id);
  if (!ok) return notFoundResponse();
  return NextResponse.json({ deleted: true });
}
