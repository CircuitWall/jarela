import { tool } from "@langchain/core/tools";
import { z } from "zod";

export interface LinkedInEnterpriseAuth { accessToken: string; version?: string; }
export type AuthResolver = () => LinkedInEnterpriseAuth | { error: string };
let resolver: AuthResolver = resolveLinkedInEnterpriseAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void { resolver = fn; }
export function resolveLinkedInEnterpriseAuthFromEnv(): LinkedInEnterpriseAuth | { error: string } {
  const accessToken = process.env.LINKEDIN_ENTERPRISE_ACCESS_TOKEN?.trim();
  return accessToken ? { accessToken, version: process.env.LINKEDIN_VERSION?.trim() } : {
    error: "LinkedIn Enterprise is not configured. Set LINKEDIN_ENTERPRISE_ACCESS_TOKEN or connect the integration.",
  };
}
export function _resolveLinkedInEnterpriseAuth(): LinkedInEnterpriseAuth | { error: string } { return resolver(); }

const API = "https://api.linkedin.com/rest";
const apiVersion = (auth: LinkedInEnterpriseAuth): string => auth.version?.trim() || "202608";
function organizationUrn(id: string): string { return id.startsWith("urn:li:organization:") ? id : `urn:li:organization:${id}`; }

async function request(auth: LinkedInEnterpriseAuth, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Linkedin-Version": apiVersion(auth),
      "X-Restli-Protocol-Version": "2.0.0",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) return { error: `LinkedIn request failed with HTTP ${response.status}`, details: body };
  return body;
}
function auth(): LinkedInEnterpriseAuth | { error: string } { return resolver(); }

export const linkedinEnterpriseGetOrganizationTool = tool(async ({ organization_id }) => {
  const credentials = auth();
  if ("error" in credentials) return JSON.stringify(credentials);
  return JSON.stringify(await request(credentials, `/organizations/${encodeURIComponent(organizationUrn(organization_id))}`));
}, {
  name: "linkedin_enterprise_get_organization",
  description: "Get a LinkedIn organization page. The authenticated member must have suitable organization access.",
  schema: z.object({ organization_id: z.string().min(1).describe("Numeric LinkedIn organization id or organization URN") }),
});

export const linkedinEnterpriseListOrganizationsTool = tool(async () => {
  const credentials = auth();
  if ("error" in credentials) return JSON.stringify(credentials);
  const query = new URLSearchParams({ q: "roleAssignee", role: "ADMINISTRATOR", state: "APPROVED", count: "100" });
  return JSON.stringify(await request(credentials, `/organizationAcls?${query}`));
}, {
  name: "linkedin_enterprise_list_administered_organizations",
  description: "List organizations where the authenticated member has an approved administrator role.",
  schema: z.object({}),
});

export const linkedinEnterpriseListPostsTool = tool(async ({ organization_id, count }) => {
  const credentials = auth();
  if ("error" in credentials) return JSON.stringify(credentials);
  const query = new URLSearchParams({ q: "author", author: organizationUrn(organization_id), count: String(Math.min(count ?? 10, 100)), sortBy: "CREATED" });
  return JSON.stringify(await request(credentials, `/posts?${query}`));
}, {
  name: "linkedin_enterprise_list_posts",
  description: "List recent posts authored by a LinkedIn organization page.",
  schema: z.object({ organization_id: z.string().min(1), count: z.number().int().min(1).max(100).optional() }),
});

export const linkedinEnterpriseCreatePostTool = tool(async ({ organization_id, text }) => {
  const credentials = auth();
  if ("error" in credentials) return JSON.stringify(credentials);
  const body = {
    author: organizationUrn(organization_id),
    commentary: text,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  return JSON.stringify(await request(credentials, "/posts", { method: "POST", body: JSON.stringify(body) }));
}, {
  name: "linkedin_enterprise_create_post",
  description: "Publish a public text post for a LinkedIn organization page. This creates an external side effect.",
  schema: z.object({ organization_id: z.string().min(1), text: z.string().min(1).max(3000) }),
});

export const linkedinEnterpriseReadTools = [linkedinEnterpriseGetOrganizationTool, linkedinEnterpriseListOrganizationsTool, linkedinEnterpriseListPostsTool] as const;
export const linkedinEnterpriseWriteTools = [linkedinEnterpriseCreatePostTool] as const;
export const linkedinEnterpriseExecuteTools = [] as const;
export const linkedinEnterpriseTools = [...linkedinEnterpriseReadTools, ...linkedinEnterpriseWriteTools] as const;
