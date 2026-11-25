import { NextRequest } from "next/server";
import {
  exchangeCode,
  getAccessibleResources,
  getFlow,
  getUserInfo,
  updateFlow,
} from "@/lib/integrations/atlassian-oauth";
import { saveIntegration } from "@/lib/stores/integrations";
import {
  getCredential,
  getCredentialParams,
  updateCredential,
} from "@/lib/stores/credentials";
import { escapeHtml, oauthHtmlResponse } from "@/app/api/v1/integrations/oauth-callback";
import { errorMessage } from "@/lib/utils/error";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

// GET /api/v1/integrations/atlassian/oauth/callback?code=...&state=...
//
// Atlassian redirects the user's browser here after consent. We look up the
// pending flow by `state`, exchange the auth code for tokens, fetch the
// user's accessible cloud resources (cloud IDs), persist the integration,
// and return a small HTML page telling the user they can close the tab.
// The Integrations panel polls /oauth/status separately.

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
    return oauthHtmlResponse(
      `Atlassian reported an error: ${escapeHtml(errParam)}. You can close this tab.`,
      true,
    );
  }
  if (!code) {
    updateFlow(state, { status: "error", error: "no code returned" });
    return oauthHtmlResponse("Atlassian did not return an authorization code.", true);
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
        "Atlassian did not return a refresh_token. Make sure your OAuth app includes the " +
        "'offline_access' scope and that you grant consent when prompted.";
      updateFlow(state, { status: "error", error: msg });
      return oauthHtmlResponse(msg, true);
    }

    // Fetch accessible resources to get the default cloud ID for the site.
    let cloudId: string | undefined;
    let siteName: string | undefined;
    try {
      const resources = await getAccessibleResources(tok.access_token);
      if (resources.length > 0) {
        cloudId = resources[0].id;
        siteName = resources[0].name;
      }
    } catch {
      // Non-fatal — the token is saved and cloud ID can be set later.
    }

    // Fetch user info for a confirmation message.
    let userDisplay = "";
    try {
      const user = await getUserInfo(tok.access_token);
      if (user.name || user.email) {
        userDisplay = ` as ${user.name || user.email}`;
      }
    } catch {
      // Non-fatal — user info is just for display.
    }

    const saved = persistTokens({
      credentialId: flow.credentialId,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      refreshToken: tok.refresh_token,
      cloudId,
    });
    if ("error" in saved) {
      updateFlow(state, { status: "error", error: saved.error });
      return oauthHtmlResponse(`Failed to save: ${escapeHtml(saved.error)}`, true);
    }
    updateFlow(state, { status: "done" });
    return oauthHtmlResponse(
      `Atlassian connected${userDisplay}.${siteName ? ` Default site: ${escapeHtml(siteName)}.` : ""} ` +
        "You can close this tab and return to Jarela.",
      false,
    );
  } catch (e) {
    const msg = errorMessage(e);
    updateFlow(state, { status: "error", error: msg });
    return oauthHtmlResponse(`Token exchange failed: ${escapeHtml(msg)}`, true);
  }
}

function persistTokens(input: {
  credentialId?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  cloudId?: string;
}): { error: string } | { ok: true } {
  if (input.credentialId) {
    const cred = getCredential(input.credentialId);
    if (!cred || cred.provider !== "atlassian") {
      return { error: NOT_FOUND_ERRORS.CREDENTIAL };
    }
    const merged: Record<string, unknown> = {
      ...getCredentialParams(cred),
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    };
    if (input.cloudId) merged.cloud_id = input.cloudId;
    updateCredential(input.credentialId, { auth_method: "oauth", params: merged });
    return { ok: true };
  }
  const incoming: Record<string, string> = {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  };
  if (input.cloudId) incoming.cloud_id = input.cloudId;
  const saved = saveIntegration("atlassian", incoming);
  if ("error" in saved) return saved;
  return { ok: true };
}