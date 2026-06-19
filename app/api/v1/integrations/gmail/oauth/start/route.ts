import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildAuthorizeUrl, createFlow } from "@/lib/integrations/gmail-oauth";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { SECRET_MASK } from "@/lib/stores/integrations";
import { getCredential, getCredentialParams } from "@/lib/stores/credentials";

// POST /api/v1/integrations/gmail/oauth/start
// Body: { client_id?, client_secret?, credential_id? }
// Returns: { authorize_url, state, redirect_uri }
//
// Stashes the credentials in an in-memory flow keyed by `state`. The browser
// then opens authorize_url; Google bounces back to /oauth/callback which
// exchanges the code + persists the integration. Client polls /oauth/status.
//
// When `credential_id` is provided the callback will write the refresh
// token onto that specific credential row, and masked client_id/secret
// fields fall back to that row's saved params instead of the default.

const BodySchema = z.object({
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
  credential_id: z.string().trim().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }

  // Pre-load saved values from either the targeted credential row or the
  // legacy default integration, so the user can re-auth without retyping
  // the client secret. The targeted row wins when both are present.
  const targeted = parsed.data.credential_id
    ? getCredential(parsed.data.credential_id)
    : null;
  if (parsed.data.credential_id && (!targeted || targeted.provider !== "gmail")) {
    return NextResponse.json({ error: "credential not found" }, { status: 404 });
  }
  const targetedParams = targeted ? getCredentialParams(targeted) : {};
  const existing = getIntegrationRaw("gmail") ?? {};
  const fallbackClientId = (targetedParams.client_id as string | undefined) ?? existing.client_id;
  const fallbackClientSecret =
    (targetedParams.client_secret as string | undefined) ?? existing.client_secret;

  const clientId =
    parsed.data.client_id && parsed.data.client_id !== SECRET_MASK
      ? parsed.data.client_id
      : fallbackClientId;
  const clientSecret =
    parsed.data.client_secret && parsed.data.client_secret !== SECRET_MASK
      ? parsed.data.client_secret
      : fallbackClientSecret;

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

  const { state } = createFlow({
    clientId,
    clientSecret,
    redirectUri,
    credentialId: targeted?.id,
  });
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });

  return NextResponse.json({ authorize_url: authorizeUrl, state, redirect_uri: redirectUri });
}
