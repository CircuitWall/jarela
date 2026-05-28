import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import {
  deleteCustomHarness,
  getHarness,
  updateCustomHarness,
} from "@/lib/stores/harnesses";
import { HARNESS_SECTION_KEYS, isBuiltinHarnessId } from "@/lib/agents/harness/types";

const sectionSchema = z.object({
  enabled: z.boolean().optional(),
  body: z.string().optional(),
});

const sectionsSchema = z
  .object(
    Object.fromEntries(
      HARNESS_SECTION_KEYS.map((k) => [k, sectionSchema.optional()]),
    ) as Record<(typeof HARNESS_SECTION_KEYS)[number], z.ZodOptional<typeof sectionSchema>>,
  )
  .partial();

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  sections: sectionsSchema.optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const harness = getHarness(id);
  if (!harness) return notFoundResponse("Harness not found");
  return NextResponse.json(harness);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (isBuiltinHarnessId(id)) {
    return errorResponse("built-in harnesses are read-only — clone first", 400);
  }
  const parsed = await validateBody(req, patchSchema);
  if (parsed instanceof Response) return parsed;
  const updated = updateCustomHarness(id, parsed);
  if (!updated) return notFoundResponse("Harness not found");
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (isBuiltinHarnessId(id)) {
    return errorResponse("built-in harnesses cannot be deleted", 400);
  }
  const ok = deleteCustomHarness(id);
  if (!ok) return notFoundResponse("Harness not found");
  return NextResponse.json({ deleted: true });
}
