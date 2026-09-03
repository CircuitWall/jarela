import { tool } from "@langchain/core/tools";
import { z } from "zod";

export interface LinkedInPersonalAuth { accessToken: string; version?: string; }
export type AuthResolver = () => LinkedInPersonalAuth | { error: string };
let resolver: AuthResolver = resolveLinkedInPersonalAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void { resolver = fn; }
export function resolveLinkedInPersonalAuthFromEnv(): LinkedInPersonalAuth | { error: string } {
  const accessToken = process.env.LINKEDIN_PERSONAL_ACCESS_TOKEN?.trim();
  return accessToken ? { accessToken, version: process.env.LINKEDIN_VERSION?.trim() } : {
    error: "LinkedIn Personal is not configured. Set LINKEDIN_PERSONAL_ACCESS_TOKEN or connect the integration.",
  };
}
export function _resolveLinkedInPersonalAuth(): LinkedInPersonalAuth | { error: string } { return resolver(); }

const OIDC_API = "https://api.linkedin.com/v2";
const REST_API = "https://api.linkedin.com/rest";
const apiVersion = (auth: LinkedInPersonalAuth): string => auth.version?.trim() || "202608";

async function request(auth: LinkedInPersonalAuth, base: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(base === REST_API ? { "Linkedin-Version": apiVersion(auth), "X-Restli-Protocol-Version": "2.0.0" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) return { error: `LinkedIn request failed with HTTP ${response.status}`, details: body };
  return body;
}

function auth(): LinkedInPersonalAuth | { error: string } { return resolver(); }

export const linkedinPersonalGetProfileTool = tool(async () => {
  const credentials = auth();
  if ("error" in credentials) return JSON.stringify(credentials);
  return JSON.stringify(await request(credentials, OIDC_API, "/userinfo"));
}, {
  name: "linkedin_personal_get_profile",
  description: "Get the authenticated LinkedIn member's OpenID Connect profile.",
  schema: z.object({}),
});

export const linkedinPersonalCreatePostTool = tool(async ({ text, visibility }) => {
  const credentials = auth();
  if ("error" in credentials) return JSON.stringify(credentials);
  const profile = await request(credentials, OIDC_API, "/userinfo") as { sub?: string; error?: string };
  if (profile.error || !profile.sub) return JSON.stringify(profile.error ? profile : { error: "LinkedIn profile did not include a member id" });
  return JSON.stringify(await request(credentials, REST_API, "/posts", {
    method: "POST",
    body: JSON.stringify({
      author: `urn:li:person:${profile.sub}`,
      commentary: text,
      visibility,
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  }));
}, {
  name: "linkedin_personal_create_post",
  description: "Publish a text post as the authenticated LinkedIn member. This creates an external side effect.",
  schema: z.object({ text: z.string().min(1).max(3000), visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC") }),
});

export const linkedinPersonalReadTools = [linkedinPersonalGetProfileTool] as const;
export const linkedinPersonalWriteTools = [linkedinPersonalCreatePostTool] as const;
export const linkedinPersonalExecuteTools = [] as const;
export const linkedinPersonalTools = [...linkedinPersonalReadTools, ...linkedinPersonalWriteTools] as const;
