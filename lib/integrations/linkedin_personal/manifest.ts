import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const linkedinPersonalManifest: IntegrationManifest = {
  id: "linkedin_personal",
  name: "LinkedIn Personal",
  summary: "Connects a LinkedIn member account to read the authenticated profile and publish text posts.",
  category: "other",
  prerequisites: [
    { check: "oauth_app", detail: "A LinkedIn Developer App with Sign In with LinkedIn using OpenID Connect and Share on LinkedIn enabled." },
    { check: "credentials", detail: "Member consent for openid, profile, email, and w_member_social." },
  ],
  steps: [
    { id: "create-app", title: "Configure a LinkedIn app", description: "Create a LinkedIn Developer App, enable the required products, and register the HTTPS callback URL shown by Jarela.", docs_url: "https://www.linkedin.com/developers/" },
    { id: "connect", title: "Connect the member account", description: "Start LinkedIn OAuth and approve only the requested member profile and publishing permissions.", proposes: "start_oauth", verify: { tool: "linkedin_personal_get_profile" } },
  ],
  troubleshooting: [
    { when: "OAuth reports invalid scope", say: "Enable OpenID Connect and Share on LinkedIn for this app, then reconnect. Do not request restricted r_member_social for this package." },
    { when: "post creation returns 403", say: "The token needs w_member_social and must belong to the member whose Person URN is used." },
    { when: "the token expires", say: "LinkedIn access tokens are finite-lived. Reconnect the integration; programmatic refresh is partner-limited." },
  ],
};
