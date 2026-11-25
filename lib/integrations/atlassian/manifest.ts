import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const atlassianManifest: IntegrationManifest = {
  id: "atlassian",
  name: "Atlassian (Jira + Confluence)",
  summary:
    "Lets the agent search and modify Jira issues, read and post comments, and " +
    "read Confluence pages. Also powers smart-indexed document RAG over selected " +
    "Jira projects/JQL and Confluence spaces/CQL via the documents_add_remote_source " +
    "tool (ADR-0026). Authenticates via OAuth 2.0 (3-legged OAuth) or an Atlassian " +
    "API token tied to your account email.",
  category: "issue-tracker",
  prerequisites: [
    {
      check: "oauth_app",
      detail:
        "An OAuth 2.0 integration created at developer.atlassian.com/console/myapps/. " +
        "Click Create > OAuth 2.0 integration, name it (e.g. 'Jarela'), and set the " +
        "Callback URL to match the redirect URI on the next step. Copy the Client ID " +
        "and Client Secret — you'll paste them into Jarela.",
      docs_url:
        "https://developer.atlassian.com/console/myapps/",
    },
    {
      check: "custom",
      detail:
        "The OAuth app's Callback URL must match where Jarela is reachable. " +
        "For local use that's typically " +
        "http://localhost:4312/api/v1/integrations/atlassian/oauth/callback.",
    },
    {
      check: "credentials",
      detail:
        "If you prefer an API token over OAuth, create one at id.atlassian.com -> Security -> " +
        "API tokens. The token is bound to your account email. Provide both the email and token " +
        "in the credentials fields. Scoped tokens also need the Cloud ID.",
      docs_url:
        "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
    },
  ],
  steps: [
    {
      id: "create-oauth-app",
      title: "Create an Atlassian OAuth 2.0 integration",
      description:
        "Open developer.atlassian.com/console/myapps/, click Create > OAuth 2.0 integration. " +
        "Name it 'Jarela' and set the Callback URL to " +
        "http://localhost:4312/api/v1/integrations/atlassian/oauth/callback (adjust the " +
        "port if Jarela runs on a different one). Copy the Client ID and Client Secret.",
      docs_url:
        "https://developer.atlassian.com/console/myapps/",
    },
    {
      id: "save-oauth-client",
      title: "Save the OAuth client in Jarela",
      description:
        "Propose enabling the integration. The user pastes Client ID and Client Secret. " +
        "Both are stored encrypted at rest.",
      proposes: "enable_integration",
    },
    {
      id: "authorize",
      title: "Run the Atlassian OAuth consent flow",
      description:
        "Once OAuth credentials are saved, propose start_oauth. The user approves, " +
        "Atlassian's consent screen opens in a new tab. After granting access, a refresh " +
        "token is captured and the integration is connected.",
      proposes: "start_oauth",
      verify: { tool: "jira_get_myself" },
    },
  ],
  troubleshooting: [
    {
      when: "tool returns 401 Unauthorized",
      say:
        "The OAuth token or API token is invalid or revoked. For OAuth, propose start_oauth " +
        "to re-authorize. For API tokens, ask the user to regenerate the token at " +
        "id.atlassian.com -> Security -> API tokens.",
    },
    {
      when: "OAuth returns 'redirect_uri_mismatch'",
      say:
        "The Callback URL in the Atlassian OAuth app doesn't match the redirect URI Jarela " +
        "is using. Open developer.atlassian.com/console/myapps/ -> the app -> Authorization, " +
        "and verify the Callback URL matches exactly (scheme, host, port, path).",
    },
    {
      when: "tool returns 403 Forbidden on a specific issue or page",
      say:
        "The account doesn't have permission for that resource. Either the project/space hasn't " +
        "been shared with this user, or the issue is restricted. Ask the user to verify in the " +
        "Atlassian web UI.",
    },
    {
      when: "tool returns 404 on a Confluence page id",
      say:
        "Confluence page ids change when pages are moved between spaces. Ask the user to re-share " +
        "the page URL — the integration will resolve it to the current id.",
    },
    {
      when: "consent fails with insufficient scope",
      say:
        "The user consented to fewer scopes than the integration needs. Propose start_oauth — " +
        "the consent screen will re-prompt for the missing permission.",
    },
  ],
};