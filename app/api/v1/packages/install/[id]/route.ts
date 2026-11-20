import { NextRequest, NextResponse } from "next/server";
import { errorJson, errorResponse } from "@/lib/api/responses";
import {
  approvePackageInstall,
  denyPackageInstall,
} from "@/lib/tools/packages/package-install";
import { describeInstallError } from "@/lib/tools/packages/install-error";
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
    const failure = describeInstallError(err);
    if (failure) return errorJson(failure.body, { status: failure.status });
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
