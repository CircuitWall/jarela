import { NextRequest } from "next/server";
import { exchangeCode, getFlow, updateFlow } from "@/lib/integrations/gmail-oauth";
import { saveIntegration } from "@/lib/stores/integrations";
import { escapeHtml, oauthHtmlResponse } from "@/app/api/v1/integrations/oauth-callback";

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
    const tok = await exchangeCode({
      code,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      redirectUri: flow.redirectUri,
    });
    if (!tok.refresh_token) {
      const msg =
        "Google did not return a refresh_token. This usually means you have previously " +
        "authorized this client. Revoke it at https://myaccount.google.com/permissions and retry.";
      updateFlow(state, { status: "error", error: msg });
      return oauthHtmlResponse(msg, true);
    }
    const saved = saveIntegration("gmail", {
      client_id: flow.clientId,
      client_secret: flow.clientSecret,
      refresh_token: tok.refresh_token,
    });
    if ("error" in saved) {
      updateFlow(state, { status: "error", error: saved.error });
      return oauthHtmlResponse(`Failed to save: ${escapeHtml(saved.error)}`, true);
    }
    updateFlow(state, { status: "done" });
    return oauthHtmlResponse("Gmail connected. You can close this tab and return to Jarela.", false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateFlow(state, { status: "error", error: msg });
    return oauthHtmlResponse(`Token exchange failed: ${escapeHtml(msg)}`, true);
  }
}
