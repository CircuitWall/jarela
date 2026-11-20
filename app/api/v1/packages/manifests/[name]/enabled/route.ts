import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import { setManifestEnabled } from "@/lib/tools/packages/package-manifests";
import { gateEnable } from "@/lib/dependencies/gate";
import { errorMessage } from "@/lib/utils/error";

const ToggleSchema = z.object({
  enabled: z.boolean(),
  /** Install the manifest's package when enabling (ADR-0121). Defaults to true. */
  install_missing: z.boolean().optional(),
});

interface Ctx {
  params: Promise<{ name: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const parsed = await validateBody(req, ToggleSchema);
  if (parsed instanceof NextResponse) return parsed;
  try {
    let install: unknown = null;
    if (parsed.enabled) {
      const gate = await gateEnable(
        { kind: "manifest", id: name },
        { installMissing: parsed.install_missing ?? true },
      );
      if (gate.reason === "unknown_target") {
        return notFoundResponse(`manifest "${name}" not found`);
      }
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

    const result = await setManifestEnabled(name, parsed.enabled);
    return NextResponse.json({
      name: result.record.name,
      enabled: result.record.enabled,
      record: result.record,
      load: result.load,
      install,
    });
  } catch (err) {
    const msg = errorMessage(err);
    if (/not found/i.test(msg)) return notFoundResponse(msg);
    return errorResponse(msg, 400);
  }
}
