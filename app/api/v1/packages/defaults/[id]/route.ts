import { NextRequest, NextResponse } from "next/server";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import { z } from "zod";
import {
  findDefaultPackage,
  listDefaultPackages,
  setDefaultPackageEnabled,
} from "@/lib/tools/packages/default-packages";
import { setPackageDisabled } from "@/lib/stores/disabled-packages";
import { gateEnable } from "@/lib/dependencies/gate";
import { errorMessage } from "@/lib/utils/error";

const ToggleSchema = z.object({
  enabled: z.boolean(),
  /**
   * Install missing dependencies as part of enabling (ADR-0121). Defaults to
   * true: an explicit enable is the request to obtain what it needs. Pass
   * false to only check and get the plan back.
   */
  install_missing: z.boolean().optional(),
});

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
    let install: unknown = null;
    if (parsed.enabled) {
      const gate = await gateEnable(
        { kind: "package", id },
        { installMissing: parsed.install_missing ?? true },
      );
      if (!gate.ok) {
        return NextResponse.json(
          {
            status: "dependency_blocked",
            reason: gate.reason,
            resolution: gate.resolution,
            install: gate.install,
          },
          { status: 409 },
        );
      }
      install = gate.install ? { status: gate.install.status, ran: gate.install.ran } : null;
    }

    setPackageDisabled(id, !parsed.enabled);
    setDefaultPackageEnabled(id, parsed.enabled);

    const updated = listDefaultPackages().find((p) => p.id === id);
    return NextResponse.json({ id, enabled: parsed.enabled, package: updated, install });
  } catch (err) {
    return errorResponse(errorMessage(err), 500);
  }
}
