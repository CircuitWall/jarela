import { NextRequest } from "next/server";
import {
  exchangeCode,
  getFlow,
  isDefaultGoogleClient,
  updateFlow,
} from "@/lib/integrations/gmail-oauth";
import { saveIntegration } from "@/lib/stores/integrations";
import {
  getCredential,
  getCredentialParams,
  updateCredential,
} from "@/lib/stores/credentials";
import { escapeHtml, oauthHtmlResponse } from "@/app/api/v1/integrations/oauth-callback";
import { errorMessage } from "@/lib/utils/error";

// GET /api/v1/integrations/gmail/oauth/callback?code=…&state=…
//
// Google redirects the user's browser here after consent. We look up the
// pending flow by `state`, exchange the auth code for a refresh_token, persist
// the integration, and return a small HTML page telling the user they can
// close the tab. The Integrations panel polls /oauth/status separately.

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const errParam = url.searchParams.get("error");

  const flow = state ? getFlow(state) : undefined;
  if (!flow) {
    return oauthHtmlResponse("Authorization session not found or expired. Please retry from Jarela.", true);
  }

  if (errParam) {
    updateFlow(state, { status: "error", error: errParam });
    return oauthHtmlResponse(`Google reported an error: ${escapeHtml(errParam)}. You can close this tab.`, true);
  }
  if (!code) {
    updateFlow(state, { status: "error", error: "no code returned" });
    return oauthHtmlResponse("Google did not return an authorization code.", true);
  }

  try {
    if (!flow.codeVerifier) {
      // Older flow rows from a downgraded process. Bounce so the panel
      // restarts cleanly with a PKCE-aware /oauth/start call.
      const msg = "OAuth session is stale (missing PKCE verifier). Click Connect again.";
      updateFlow(state, { status: "error", error: msg });
      return oauthHtmlResponse(msg, true);
    }
    const tok = await exchangeCode({
      code,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret || undefined,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
    });
    if (!tok.refresh_token) {
      const msg =
        "Google did not return a refresh_token. This usually means you have previously " +
        "authorized this client. Revoke it at https://myaccount.google.com/permissions and retry.";
      updateFlow(state, { status: "error", error: msg });
      return oauthHtmlResponse(msg, true);
    }
    const saved = persistRefreshToken({
      credentialId: flow.credentialId,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret || undefined,
      refreshToken: tok.refresh_token,
    });
    if ("error" in saved) {
      updateFlow(state, { status: "error", error: saved.error });
      return oauthHtmlResponse(`Failed to save: ${escapeHtml(saved.error)}`, true);
    }
    updateFlow(state, { status: "done" });
    return oauthHtmlResponse("Gmail connected. You can close this tab and return to Jarela.", false);
  } catch (e) {
    const msg = errorMessage(e);
    updateFlow(state, { status: "error", error: msg });
    return oauthHtmlResponse(`Token exchange failed: ${escapeHtml(msg)}`, true);
  }
}

// Writes the freshly-minted refresh token to either the targeted
// credential row (per-credential OAuth flow) or the provider's default
// integration (legacy flow).
//
// When the flow used the bundled Jarela Desktop client (NOT a BYO from the
// Advanced panel), we deliberately persist only the refresh token. The
// client_id gets re-derived from the binary on each refresh via
// `resolveGoogleAuth` — no client_secret is involved on the bundled path,
// since Desktop+PKCE doesn't require one.
function persistRefreshToken(input: {
  credentialId?: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): { error: string } | { ok: true } {
  const isBundled = isDefaultGoogleClient(input.clientId) && !input.clientSecret;
  if (input.credentialId) {
    const cred = getCredential(input.credentialId);
    if (!cred || cred.provider !== "gmail") {
      return { error: "credential not found" };
    }
    const existing = getCredentialParams(cred);
    const merged: Record<string, unknown> = {
      ...existing,
      refresh_token: input.refreshToken,
    };
    if (isBundled) {
      // Drop any BYO leftovers so the resolver falls through to the bundle.
      delete merged.client_id;
      delete merged.client_secret;
    } else {
      merged.client_id = input.clientId;
      if (input.clientSecret) merged.client_secret = input.clientSecret;
      else delete merged.client_secret;
    }
    updateCredential(input.credentialId, { auth_method: "oauth", params: merged });
    return { ok: true };
  }
  const incoming: Record<string, string> = { refresh_token: input.refreshToken };
  if (!isBundled) {
    incoming.client_id = input.clientId;
    if (input.clientSecret) incoming.client_secret = input.clientSecret;
  }
  const saved = saveIntegration("gmail", incoming);
  if ("error" in saved) return saved;
  return { ok: true };
}
