import { NextRequest, NextResponse } from "next/server";
import { isIntegrationProbe, runProbe } from "@/lib/health/probes";

type Params = { params: Promise<{ name: string }> };

// POST /api/v1/integrations/{name}/test
// Performs a real API call against the integration to confirm credentials
// work. Delegates to the shared probe layer (lib/health/probes.ts) so the
// scheduler-driven health monitor uses the exact same logic.
export async function POST(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  if (!isIntegrationProbe(name)) {
    return NextResponse.json({ error: "unknown integration" }, { status: 404 });
  }
  const result = await runProbe(name);
  if (result.ok) return NextResponse.json({ ok: true, detail: result.detail ?? {} });
  // Surface "unconfigured" as 400 (operator must fill in credentials);
  // every other failure mode is a 200 with ok:false so the UI can render
  // the error inline without treating it as a transport failure.
  const status = result.status === "unconfigured" ? 400 : 200;
  return NextResponse.json({ ok: false, error: result.error ?? "unknown error" }, { status });
}
