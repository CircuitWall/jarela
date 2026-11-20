/**
 * @public — `POST /api/v1/dependencies/install`
 *
 * Installs the missing dependencies of one target after an explicit request
 * (ADR-0121). Allowlisted publishers install immediately; non-allowlisted
 * managed packages return `202` with a pending approval, and non-allowlisted
 * global installs are refused with the exact command to run.
 *
 * The response always includes the plan before and after the attempt, so the
 * caller can show what happened rather than what was intended.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorJson, notFoundResponse, validateBody } from "@/lib/api/responses";
import { installDependencies } from "@/lib/dependencies/install";
import { parseTarget } from "@/lib/dependencies/plan";

const InstallSchema = z.object({
  target: z.string().trim().min(3).max(300),
});

export const dynamic = "force-dynamic";

const STATUS_CODES: Record<string, number> = {
  installed: 200,
  already_ready: 200,
  pending_approval: 202,
  blocked: 409,
  manual: 409,
  failed: 409,
};

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, InstallSchema);
  if (parsed instanceof NextResponse) return parsed;

  const target = parseTarget(parsed.target);
  if (!target) {
    return errorJson(
      { error: "invalid target", detail: "expected kind:id where kind is tool, integration, package, manifest or mcp" },
      { status: 400 },
    );
  }

  try {
    const outcome = await installDependencies(target);
    if (outcome.plan.status === "unknown_target" && outcome.status === "failed") {
      return notFoundResponse(`unknown dependency target: ${parsed.target}`);
    }
    return NextResponse.json(outcome, { status: STATUS_CODES[outcome.status] ?? 200 });
  } catch (err) {
    return errorJson(
      { error: "dependency install failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
