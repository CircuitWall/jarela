import { NextRequest, NextResponse } from "next/server";
import { _resolveAtlassianAuth } from "@/lib/tools/atlassian";

type Params = { params: Promise<{ name: string }> };

// POST /api/v1/integrations/{name}/test
// Performs a real API call against the integration to confirm credentials work.
// Surfaces a clear ok/error so the user knows immediately whether their setup
// is good — without having to ask the agent to use the tool.
export async function POST(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  switch (name) {
    case "atlassian": return await testAtlassian();
    default:          return NextResponse.json({ error: "unknown integration" }, { status: 404 });
  }
}

async function testAtlassian() {
  const auth = _resolveAtlassianAuth();
  if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: 400 });
  try {
    const res = await fetch(`${auth.url}/rest/api/3/myself`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64"),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, error: `Atlassian ${res.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    const me = (await res.json()) as { displayName?: string; emailAddress?: string; accountId?: string };
    return NextResponse.json({
      ok: true,
      detail: {
        displayName: me.displayName,
        email: me.emailAddress,
        accountId: me.accountId,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}
