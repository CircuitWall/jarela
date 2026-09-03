import { getIntegrationRaw } from "@/lib/stores/integrations";
import { createCredential, getCredential, getCredentialParams, nextCredentialId, updateCredential } from "@/lib/stores/credentials";
import { createOAuthFlowStore, type OAuthFlow } from "@/lib/utils/oauth-flow-store";
import { parseJsonSafe } from "@/lib/utils/json";
import { sanitizeOAuthInput } from "@/lib/utils/oauth-input";

export type LinkedInOAuthKind = "personal" | "enterprise";
export type LinkedInOAuthInput = { clientId?: string; clientSecret?: string; credentialId?: string; scopes?: string };

const CONFIG = {
  personal: { integrationId: "linkedin_personal", clientIdEnv: "LINKEDIN_PERSONAL_CLIENT_ID", clientSecretEnv: "LINKEDIN_PERSONAL_CLIENT_SECRET", scopes: ["openid", "profile", "email", "w_member_social"] },
  enterprise: { integrationId: "linkedin_enterprise", clientIdEnv: "LINKEDIN_ENTERPRISE_CLIENT_ID", clientSecretEnv: "LINKEDIN_ENTERPRISE_CLIENT_SECRET", scopes: ["r_organization_admin", "r_organization_social", "w_organization_social"] },
} as const;

export const LINKEDIN_PERSONAL_SCOPES = ["openid", "profile", "email", "w_member_social"] as const;
export const LINKEDIN_ENTERPRISE_SCOPES = ["r_organization_admin", "r_organization_social", "w_organization_social"] as const;

const stores = {
  personal: createOAuthFlowStore({ globalKey: "__linkedinPersonalOauthFlows" }),
  enterprise: createOAuthFlowStore({ globalKey: "__linkedinEnterpriseOauthFlows" }),
};

export function getFlow(kind: LinkedInOAuthKind, state: string): OAuthFlow | undefined { return stores[kind].get(state); }
export function updateFlow(kind: LinkedInOAuthKind, state: string, patch: Partial<OAuthFlow>): void { stores[kind].update(state, patch); }

function config(kind: LinkedInOAuthKind) { return CONFIG[kind]; }

export function createFlow(kind: LinkedInOAuthKind, input: LinkedInOAuthInput & { redirectUri: string }): { state: string; flow: OAuthFlow } {
  const c = config(kind);
  const saved = getIntegrationRaw(c.integrationId) || {};
  const clientId = sanitizeOAuthInput(input.clientId) || process.env[c.clientIdEnv]?.trim() || saved.client_id || "";
  const clientSecret = sanitizeOAuthInput(input.clientSecret) || process.env[c.clientSecretEnv]?.trim() || saved.client_secret || "";
  if (!clientId || !clientSecret) throw new Error(`LinkedIn ${kind} OAuth client is not configured`);
  const allowed = kind === "personal" ? LINKEDIN_PERSONAL_SCOPES : LINKEDIN_ENTERPRISE_SCOPES;
  const requested = input.scopes?.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean) ?? [];
  const scopes = requested.length > 0 ? requested : [...allowed];
  const unsupported = scopes.filter((scope) => !allowed.includes(scope as never));
  if (unsupported.length > 0) throw new Error(`Unsupported LinkedIn ${kind} scope: ${unsupported.join(", ")}`);
  return stores[kind].create({ clientId, clientSecret, redirectUri: input.redirectUri, credentialId: input.credentialId, scopes });
}

export function buildAuthorizeUrl(kind: LinkedInOAuthKind, flow: OAuthFlow, state: string): string {
  const params = new URLSearchParams({ response_type: "code", client_id: flow.clientId, redirect_uri: flow.redirectUri, state, scope: (flow.scopes ?? config(kind).scopes).join(" ") });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export async function exchangeCode(flow: OAuthFlow, code: string): Promise<{ access_token: string; expires_in?: number; scope?: string; refresh_token?: string; refresh_token_expires_in?: number }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: flow.clientId, client_secret: flow.clientSecret, redirect_uri: flow.redirectUri });
  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  const parsed = parseJsonSafe<Record<string, unknown>>(text, {});
  if (!response.ok || typeof parsed.access_token !== "string") throw new Error(String(parsed.error_description || parsed.error || `LinkedIn token exchange failed with HTTP ${response.status}`));
  return parsed as { access_token: string; expires_in?: number; scope?: string; refresh_token?: string; refresh_token_expires_in?: number };
}

export function saveToken(kind: LinkedInOAuthKind, flow: OAuthFlow, token: Awaited<ReturnType<typeof exchangeCode>>): void {
  const provider = config(kind).integrationId;
  const existing = flow.credentialId ? getCredential(flow.credentialId) : null;
  const params = {
    ...(getIntegrationRaw(provider) || {}),
    ...(existing ? getCredentialParams(existing) : {}),
    client_id: flow.clientId,
    client_secret: flow.clientSecret,
    access_token: token.access_token,
    expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined,
    granted_scopes: token.scope || flow.scopes?.join(" "),
    refresh_token: token.refresh_token,
    refresh_token_expires_in: token.refresh_token_expires_in,
    scopes: flow.scopes?.join(" "),
  };
  if (existing) { updateCredential(existing.id, { auth_method: "oauth", params }); return; }
  createCredential({ id: nextCredentialId("integration", provider), type: "integration", provider, auth_method: "oauth", params });
}
