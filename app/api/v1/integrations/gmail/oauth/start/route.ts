import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildAuthorizeUrl,
  createFlow,
  generatePkce,
  getDefaultGoogleClient,
} from "@/lib/integrations/gmail-oauth";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { getCredential, getCredentialParams } from "@/lib/stores/credentials";
import { isMaskedSecret } from "@/lib/utils/secret-mask";
import { sanitizeOAuthInput } from "@/lib/utils/oauth-input";

// POST /api/v1/integrations/gmail/oauth/start
// Body: { client_id?, client_secret?, credential_id? }
// Returns: { authorize_url, state, redirect_uri }
//
// Stashes the credentials in an in-memory flow keyed by `state`. The browser
// then opens authorize_url; Google bounces back to /oauth/callback which
// exchanges the code + persists the integration. Client polls /oauth/status.
//
// Resolution order for client_id/client_secret:
//   1. Explicit values in the request body (BYO path, "Advanced" panel)
//   2. Saved values on the targeted credential row (re-auth without retype)
//   3. Saved values on the legacy default integration row
//   4. Bundled Jarela Google Desktop client (one-click sign-in)
//
// When `credential_id` is provided the callback will write the refresh
// token onto that specific credential row, and masked client_id/secret
// fields fall back to that row's saved params instead of the default.

// Strip all whitespace (incl. invisibles) before forwarding to Google —
// paste from password managers can introduce zero-width chars that survive
// a plain `.trim()` and make Google reject the secret as `invalid_client`.
const sanitizedField = z
  .string()
  .optional()
  .transform((v) => sanitizeOAuthInput(v));

const BodySchema = z.object({
  client_id: sanitizedField,
  client_secret: sanitizedField,
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
  const defaults = getDefaultGoogleClient();
  // client_id has a bundled default (the Jarela Desktop OAuth client).
  // client_secret does NOT — only the BYO path supplies one. Desktop+PKCE
  // works without a client_secret per Google's spec.
  const fallbackClientId =
    (targetedParams.client_id as string | undefined) ?? existing.client_id ?? defaults.client_id;
  const fallbackClientSecret =
    (targetedParams.client_secret as string | undefined) ?? existing.client_secret;

  const clientId =
    parsed.data.client_id && !isMaskedSecret(parsed.data.client_id)
      ? parsed.data.client_id
      : fallbackClientId;
  const clientSecret =
    parsed.data.client_secret && !isMaskedSecret(parsed.data.client_secret)
      ? parsed.data.client_secret
      : fallbackClientSecret;

  if (!clientId) {
    return NextResponse.json(
      { error: "client_id is required (or set JARELA_GMAIL_CLIENT_ID in the server env)" },
      { status: 400 },
    );
  }
  if (clientSecret && isMaskedSecret(clientSecret)) {
    // A previously-saved row whose secret got corrupted by an earlier round
    // of save-without-retype (pre-1.14.0 mask-sentinel mismatch). Refuse to
    // forward the placeholder to Google; tell the user how to recover.
    return NextResponse.json(
      {
        error:
          "Saved client_secret looks like a placeholder. Re-enter the real OAuth client secret on this credential and click Save, then Connect again.",
      },
      { status: 400 },
    );
  }

  // Use the request's own origin as the loopback redirect target. Desktop OAuth
  // clients auto-allow http://localhost:* and http://127.0.0.1:* — no GCP setup.
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/v1/integrations/gmail/oauth/callback`;

  const pkce = generatePkce();
  const { state } = createFlow({
    clientId,
    clientSecret: clientSecret ?? "",
    redirectUri,
    codeVerifier: pkce.verifier,
    credentialId: targeted?.id,
  });
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  });

  return NextResponse.json({ authorize_url: authorizeUrl, state, redirect_uri: redirectUri });
}
