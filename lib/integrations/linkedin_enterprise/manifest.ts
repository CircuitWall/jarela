import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const linkedinEnterpriseManifest: IntegrationManifest = {
  id: "linkedin_enterprise",
  name: "LinkedIn Enterprise",
  summary: "Connects a LinkedIn member administrator to discover organizations and publish page posts.",
  category: "other",
  prerequisites: [
    { check: "oauth_app", detail: "A separate LinkedIn Developer App with Community Management API access and organization social permissions approved." },
    { check: "credentials", detail: "Member consent for r_organization_admin, r_organization_social, and w_organization_social, plus an approved page role such as ADMINISTRATOR or CONTENT_ADMIN." },
  ],
  steps: [
    { id: "create-app", title: "Configure a LinkedIn app", description: "Create a separate LinkedIn Developer App, request Community Management access, and register the HTTPS callback URL shown by Jarela.", docs_url: "https://www.linkedin.com/developers/" },
    { id: "connect", title: "Connect the page administrator", description: "Start LinkedIn OAuth as a member who administers the target page, then approve the organization permissions.", proposes: "start_oauth", verify: { tool: "linkedin_enterprise_list_administered_organizations" } },
    { id: "select-page", title: "Select an administered organization", description: "Use the administered organization list to select a page before reading or publishing its posts." },
  ],
  troubleshooting: [
    { when: "organization lookup returns 403", say: "The OAuth member lacks the required approved role for that organization, or the app lacks the required organization product." },
    { when: "post creation returns 403", say: "Confirm w_organization_social is granted and the member has an approved page role. Organization access is still member-authorized OAuth, not app-only access." },
    { when: "the token expires", say: "LinkedIn access tokens are finite-lived. Reconnect the integration; programmatic refresh is partner-limited." },
  ],
};
