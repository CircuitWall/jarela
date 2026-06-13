import { NextRequest, NextResponse } from "next/server";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import {
  createManifest,
  deleteManifest,
  getManifest,
  MANIFEST_INPUT_SCHEMA,
} from "@/lib/tools/package-manifests";
import { z } from "zod";

interface Ctx {
  params: Promise<{ name: string }>;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const record = getManifest(name);
  if (!record) return notFoundResponse(`manifest "${name}" not found`);
  return NextResponse.json(record);
}

// `name` from the URL wins; the body's `name` (if any) is ignored.
const UpdateSchema = MANIFEST_INPUT_SCHEMA.omit({ name: true });

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const parsed = await validateBody(req, UpdateSchema as z.ZodTypeAny);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const result = await createManifest(
      { ...(parsed as Omit<z.infer<typeof MANIFEST_INPUT_SCHEMA>, "name">), name },
      { replace: true },
    );
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const { removed, load } = await deleteManifest(name);
  if (!removed) return notFoundResponse(`manifest "${name}" not found`);
  return NextResponse.json({ name, removed, load });
}
