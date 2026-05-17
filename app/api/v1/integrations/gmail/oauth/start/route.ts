import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildAuthorizeUrl, createFlow } from "@/lib/integrations/gmail-oauth";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { SECRET_MASK } from "@/lib/stores/integrations";

// POST /api/v1/integrations/gmail/oauth/start
// Body: { client_id, client_secret }
// Returns: { authorize_url, state, redirect_uri }
//
// Stashes the credentials in an in-memory flow keyed by `state`. The browser
// then opens authorize_url; Google bounces back to /oauth/callback which
// exchanges the code + persists the integration. Client polls /oauth/status.

const BodySchema = z.object({
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }

  // Fall back to saved values when the form sent the masked sentinel or nothing,
  // so the user can re-auth without retyping the client secret.
  const existing = getIntegrationRaw("gmail") ?? {};
  const clientId =
    parsed.data.client_id && parsed.data.client_id !== SECRET_MASK
      ? parsed.data.client_id
      : existing.client_id;
  const clientSecret =
    parsed.data.client_secret && parsed.data.client_secret !== SECRET_MASK
      ? parsed.data.client_secret
      : existing.client_secret;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "client_id and client_secret are required (save them first or include in this request)" },
      { status: 400 },
    );
  }

  // Use the request's own origin as the loopback redirect target. Desktop OAuth
  // clients auto-allow http://localhost:* and http://127.0.0.1:* — no GCP setup.
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/v1/integrations/gmail/oauth/callback`;

  const { state } = createFlow({ clientId, clientSecret, redirectUri });
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });

  return NextResponse.json({ authorize_url: authorizeUrl, state, redirect_uri: redirectUri });
}
