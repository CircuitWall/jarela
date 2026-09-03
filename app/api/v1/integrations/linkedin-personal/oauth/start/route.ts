import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildAuthorizeUrl, createFlow } from "@/lib/integrations/linkedin-oauth";

const Body = z.object({ client_id: z.string().trim().min(1).optional(), client_secret: z.string().trim().min(1).optional(), credential_id: z.string().trim().min(1).optional(), scopes: z.string().trim().optional() });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid OAuth configuration" }, { status: 400 });
  try {
    const redirectUri = `${req.nextUrl.origin}/api/v1/integrations/linkedin-personal/oauth/callback`;
    const result = createFlow("personal", { clientId: parsed.data.client_id, clientSecret: parsed.data.client_secret, credentialId: parsed.data.credential_id, scopes: parsed.data.scopes, redirectUri });
    return NextResponse.json({ authorize_url: buildAuthorizeUrl("personal", result.flow, result.state), state: result.state, redirect_uri: redirectUri });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "OAuth setup failed" }, { status: 400 }); }
}
