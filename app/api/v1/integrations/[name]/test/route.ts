import { NextRequest, NextResponse } from "next/server";
import { isIntegrationProbe, runProbe } from "@/lib/health/probes";
import { getCredential } from "@/lib/stores/credentials";
import { runWithToolCredentialContext } from "@/lib/tools/credential-context";

type Params = { params: Promise<{ name: string }> };

// Synthetic tool name used to address the override slot in the
// `ToolCredentialContext` map — never seen by an agent, just keys the
// per-tool lookup that `resolveIntegrationCredential` already performs.
const PROBE_TOOL_NAME = "__integration_probe__";

// POST /api/v1/integrations/{name}/test
// Performs a real API call against the integration to confirm credentials
// work. Delegates to the shared probe layer (lib/health/probes.ts) so the
// scheduler-driven health monitor uses the exact same logic.
//
// Optional JSON body: { credentialId?: string }. When supplied, the probe
// runs against that specific credential row instead of the integration's
// default. Lets the multi-instance Credentials UI test a named credential
// without first promoting it to default.
export async function POST(req: NextRequest, { params }: Params) {
  const { name } = await params;
  if (!isIntegrationProbe(name)) {
    return NextResponse.json({ error: "unknown integration" }, { status: 404 });
  }

  let credentialId: string | undefined;
  try {
    const body = (await req.json().catch(() => null)) as { credentialId?: unknown } | null;
    if (body && typeof body.credentialId === "string" && body.credentialId.trim() !== "") {
      credentialId = body.credentialId.trim();
    }
  } catch {
    // Malformed body — fall back to default-credential probe.
  }

  if (credentialId) {
    const cred = getCredential(credentialId);
    if (!cred) {
      return NextResponse.json({ ok: false, error: "credential not found" }, { status: 404 });
    }
    if (cred.type !== "integration" || cred.provider !== name) {
      return NextResponse.json(
        { ok: false, error: `credential ${credentialId} does not belong to integration "${name}"` },
        { status: 400 },
      );
    }
  }

  const exec = () => runProbe(name);
  const result = credentialId
    ? await runWithToolCredentialContext(
        { toolName: PROBE_TOOL_NAME, toolCredentials: { [PROBE_TOOL_NAME]: credentialId } },
        exec,
      )
    : await exec();

  if (result.ok) return NextResponse.json({ ok: true, detail: result.detail ?? {} });
  // Surface "unconfigured" as 400 (operator must fill in credentials);
  // every other failure mode is a 200 with ok:false so the UI can render
  // the error inline without treating it as a transport failure.
  const status = result.status === "unconfigured" ? 400 : 200;
  return NextResponse.json({ ok: false, error: result.error ?? "unknown error" }, { status });
}
