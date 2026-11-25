import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildAuthorizeUrl,
  createFlow,
} from "@/lib/integrations/atlassian-oauth";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { getCredential, getCredentialParams } from "@/lib/stores/credentials";
import { isMaskedSecret } from "@/lib/utils/secret-mask";
import { sanitizeOAuthInput } from "@/lib/utils/oauth-input";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

// POST /api/v1/integrations/atlassian/oauth/start
// Body: { client_id?, client_secret?, credential_id? }
// Returns: { authorize_url, state, redirect_uri }
//
// Stashes the credentials in an in-memory flow keyed by `state`. The browser
// then opens authorize_url; Atlassian bounces back to /oauth/callback which
// exchanges the code and persists the integration. Client polls /oauth/status.
//
// Resolution order for client_id/client_secret:
//   1. Explicit values in the request body (BYO path)
//   2. Saved values on the targeted credential row (re-auth without retype)
//   3. Saved values on the legacy default integration row

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
    return errorResponse(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }

  // Pre-load saved values from either the targeted credential row or the
  // legacy default integration, so the user can re-auth without retyping.
  const targeted = parsed.data.credential_id
    ? getCredential(parsed.data.credential_id)
    : null;
  if (parsed.data.credential_id && (!targeted || targeted.provider !== "atlassian")) {
    return errorResponse(NOT_FOUND_ERRORS.CREDENTIAL, 404);
  }
  const targetedParams = targeted ? getCredentialParams(targeted) : {};
  const existing = getIntegrationRaw("atlassian") ?? {};
  const fallbackClientId =
    (targetedParams.client_id as string | undefined) ?? existing.client_id;
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

  if (!clientId || !clientSecret) {
    return errorResponse(
      "client_id and client_secret are required. " +
        "Create an OAuth 2.0 integration at https://developer.atlassian.com/console/myapps/ " +
        "and save the credentials first.",
      400,
    );
  }
  if (isMaskedSecret(clientSecret)) {
    return errorResponse(
      "Saved client_secret looks like a placeholder. Re-enter the real OAuth client secret " +
        "on this credential and click Save, then Connect again.",
      400,
    );
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/v1/integrations/atlassian/oauth/callback`;

  const { state } = createFlow({
    clientId,
    clientSecret,
    redirectUri,
    credentialId: targeted?.id,
  });
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });

  return NextResponse.json({
    authorize_url: authorizeUrl,
    state,
    redirect_uri: redirectUri,
  });
}