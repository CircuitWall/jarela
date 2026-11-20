/**
 * @public — `GET /api/v1/dependencies?target=<kind>:<id>`
 *
 * Answers "can this tool / integration / package / MCP server be enabled, and
 * what is missing?" without side effects. See ADR-0121.
 *
 * Targets: `tool:<name>`, `integration:<id>`, `package:<id>`,
 * `manifest:<name>`, `mcp:<name>`.
 */
import { NextResponse } from "next/server";
import { errorJson, notFoundResponse } from "@/lib/api/responses";
import { parseTarget, resolveDependencies } from "@/lib/dependencies/plan";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("target")?.trim() ?? "";
  const target = parseTarget(raw);
  if (!target) {
    return errorJson(
      { error: "invalid target", detail: "expected kind:id where kind is tool, integration, package, manifest or mcp" },
      { status: 400 },
    );
  }

  try {
    const resolution = await resolveDependencies(target);
    if (resolution.status === "unknown_target") {
      return notFoundResponse(`unknown dependency target: ${raw}`);
    }
    return NextResponse.json(resolution);
  } catch (err) {
    return errorJson(
      { error: "dependency resolution failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
