import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const atlassianManifest: IntegrationManifest = {
  id: "atlassian",
  name: "Atlassian (Jira + Confluence)",
  summary:
    "Lets the agent search and modify Jira issues, post comments, and read " +
    "Confluence pages. Authenticates with an Atlassian API token tied to your " +
    "account email.",
  category: "issue-tracker",
  prerequisites: [
    {
      check: "credentials",
      detail:
        "An Atlassian Cloud account with access to the site (e.g. https://your-team.atlassian.net) " +
        "and permission to view the projects/spaces you want the agent to read.",
    },
    {
      check: "credentials",
      detail:
        "An API token created at id.atlassian.com → Security → API tokens. " +
        "The token is bound to your account email — you'll provide both.",
      docs_url: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
  ],
  steps: [
    {
      id: "create-token",
      title: "Create an Atlassian API token",
      description:
        "Open id.atlassian.com → Security → API tokens, click Create API token, give it " +
        "a label like 'Jarela', and copy the token immediately — Atlassian only shows it once.",
      docs_url: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
    {
      id: "save-credentials",
      title: "Save the credentials in Jarela",
      description:
        "Propose enabling the integration. The user will be asked for the site URL, " +
        "their account email, and the API token. The token is stored encrypted at rest.",
      proposes: "enable_integration",
    },
  ],
  troubleshooting: [
    {
      when: "tool returns 401 Unauthorized",
      say:
        "The API token or email is wrong, or the token was revoked. Ask the user to regenerate " +
        "the token at id.atlassian.com → Security → API tokens and re-enter both the email and the new token.",
    },
    {
      when: "tool returns 403 Forbidden on a specific issue or page",
      say:
        "The account doesn't have permission for that resource. Either the project/space hasn't been " +
        "shared with this user, or the issue is restricted. Ask the user to verify in the Atlassian web UI.",
    },
    {
      when: "tool returns 404 on a Confluence page id",
      say:
        "Confluence page ids change when pages are moved between spaces. Ask the user to re-share " +
        "the page URL — the integration will resolve it to the current id.",
    },
  ],
};
