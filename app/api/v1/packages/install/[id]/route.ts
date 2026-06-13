import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import {
  approvePackageInstall,
  denyPackageInstall,
} from "@/lib/tools/package-install";
import { errorMessage } from "@/lib/utils/error";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const result = await approvePackageInstall(id);
    return NextResponse.json({ status: "installed", ...result });
  } catch (err) {
    const msg = errorMessage(err);
    const status = msg.startsWith("unknown approval id") ? 404 : 500;
    return errorResponse(msg, status);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const removed = denyPackageInstall(id);
  if (!removed) return errorResponse(`unknown approval id: ${id}`, 404);
  return NextResponse.json({ status: "denied", id });
}
