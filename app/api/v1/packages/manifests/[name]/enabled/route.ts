import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import { setManifestEnabled } from "@/lib/tools/package-manifests";
import { errorMessage } from "@/lib/utils/error";

const ToggleSchema = z.object({ enabled: z.boolean() });

interface Ctx {
  params: Promise<{ name: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const parsed = await validateBody(req, ToggleSchema);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const result = await setManifestEnabled(name, parsed.enabled);
    return NextResponse.json({
      name: result.record.name,
      enabled: result.record.enabled,
      record: result.record,
      load: result.load,
    });
  } catch (err) {
    const msg = errorMessage(err);
    if (/not found/i.test(msg)) return notFoundResponse(msg);
    return errorResponse(msg, 400);
  }
}
