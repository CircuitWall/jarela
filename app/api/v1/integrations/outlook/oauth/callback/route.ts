import { NextRequest } from "next/server";
import { exchangeCode, getFlow, updateFlow } from "@/lib/integrations/microsoft-oauth";
import { saveIntegration } from "@/lib/stores/integrations";
import {
  getCredential,
  getCredentialParams,
  updateCredential,
} from "@/lib/stores/credentials";
import { escapeHtml, oauthHtmlResponse } from "@/app/api/v1/integrations/oauth-callback";
import { errorMessage } from "@/lib/utils/error";

// GET /api/v1/integrations/outlook/oauth/callback?code=…&state=…
//
// Microsoft redirects the user's browser here after consent. We look up the
// pending flow by `state`, exchange the auth code for a refresh_token,
// persist the integration, and return a small HTML page telling the user
// they can close the tab. The Integrations panel polls /oauth/status.

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const errParam = url.searchParams.get("error");
  const errDesc = url.searchParams.get("error_description");

  const flow = state ? getFlow(state) : undefined;
  if (!flow) {
    return oauthHtmlResponse("Authorization session not found or expired. Please retry from Jarela.", true);
  }

  if (errParam) {
    const msg = errDesc ? `${errParam}: ${errDesc}` : errParam;
    updateFlow(state, { status: "error", error: msg });
    return oauthHtmlResponse(`Microsoft reported an error: ${escapeHtml(msg)}. You can close this tab.`, true);
  }
  if (!code) {
    updateFlow(state, { status: "error", error: "no code returned" });
    return oauthHtmlResponse("Microsoft did not return an authorization code.", true);
  }

  try {
    const tok = await exchangeCode({
      code,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      redirectUri: flow.redirectUri,
    });
    if (!tok.refresh_token) {
      const msg =
        "Microsoft did not return a refresh_token. Make sure your Azure app " +
        "registration includes the offline_access scope and that the consent " +
        "screen approves it.";
      updateFlow(state, { status: "error", error: msg });
      return oauthHtmlResponse(msg, true);
    }
    const saved = persistRefreshToken({
      credentialId: flow.credentialId,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      refreshToken: tok.refresh_token,
    });
    if ("error" in saved) {
      updateFlow(state, { status: "error", error: saved.error });
      return oauthHtmlResponse(`Failed to save: ${escapeHtml(saved.error)}`, true);
    }
    updateFlow(state, { status: "done" });
    return oauthHtmlResponse("Outlook connected. You can close this tab and return to Jarela.", false);
  } catch (e) {
    const msg = errorMessage(e);
    updateFlow(state, { status: "error", error: msg });
    return oauthHtmlResponse(`Token exchange failed: ${escapeHtml(msg)}`, true);
  }
}

function persistRefreshToken(input: {
  credentialId?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): { error: string } | { ok: true } {
  if (input.credentialId) {
    const cred = getCredential(input.credentialId);
    if (!cred || cred.provider !== "outlook") {
      return { error: "credential not found" };
    }
    const merged = {
      ...getCredentialParams(cred),
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    };
    updateCredential(input.credentialId, { auth_method: "oauth", params: merged });
    return { ok: true };
  }
  const saved = saveIntegration("outlook", {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });
  if ("error" in saved) return saved;
  return { ok: true };
}
