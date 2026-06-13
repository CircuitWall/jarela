import { NextRequest, NextResponse } from "next/server";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import { z } from "zod";
import {
  findDefaultPackage,
  listDefaultPackages,
  setDefaultPackageEnabled,
} from "@/lib/tools/default-packages";
import { setPackageDisabled } from "@/lib/stores/disabled-packages";
import { errorMessage } from "@/lib/utils/error";

const ToggleSchema = z.object({ enabled: z.boolean() });

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const descriptor = findDefaultPackage(id);
  if (!descriptor) return notFoundResponse(`default package "${id}" not found`);

  const parsed = await validateBody(req, ToggleSchema);
  if (parsed instanceof NextResponse) return parsed;

  try {
    setPackageDisabled(id, !parsed.enabled);
    setDefaultPackageEnabled(id, parsed.enabled);
  } catch (err) {
    return errorResponse(errorMessage(err), 500);
  }

  const updated = listDefaultPackages().find((p) => p.id === id);
  return NextResponse.json({ id, enabled: parsed.enabled, package: updated });
}
