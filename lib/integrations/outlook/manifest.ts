import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const outlookManifest: IntegrationManifest = {
  id: "outlook",
  name: "Outlook + Microsoft Calendar",
  summary:
    "Lets the agent search/read mail, create drafts (never send), move messages between " +
    "folders, and read or modify Microsoft 365 calendar events. Drafts-only by design — " +
    "the integration intentionally cannot send mail on the user's behalf.",
  category: "mail",
  prerequisites: [
    {
      check: "oauth_app",
      detail:
        "An Azure app registration with delegated Mail.ReadWrite, Calendars.ReadWrite, " +
        "User.Read, and offline_access permissions. Both personal Microsoft accounts and " +
        "M365 work/school accounts are supported via the 'common' tenant.",
      docs_url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    },
    {
      check: "custom",
      detail:
        "The Azure app's redirect URI must be of type 'Web' and match where Jarela is reachable. " +
        "For local use that's typically http://localhost:4312/api/v1/integrations/outlook/oauth/callback.",
    },
  ],
  steps: [
    {
      id: "register-app",
      title: "Register an Azure application",
      description:
        "Open portal.azure.com → Microsoft Entra ID → App registrations → New registration. " +
        "Name it (e.g. 'Jarela'), pick 'Accounts in any organizational directory and personal Microsoft accounts', " +
        "and set the redirect URI of type Web to match the prerequisite above.",
      docs_url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    },
    {
      id: "create-secret",
      title: "Create a client secret",
      description:
        "Inside the app registration, open Certificates & secrets → Client secrets → New client secret. " +
        "Copy the Value (not the Secret ID) immediately — Azure only shows it once.",
    },
    {
      id: "grant-scopes",
      title: "Grant the required Graph permissions",
      description:
        "API permissions → Add a permission → Microsoft Graph → Delegated permissions. " +
        "Add Mail.ReadWrite, Calendars.ReadWrite, User.Read, offline_access. " +
        "No admin consent required for personal accounts; M365 tenants may need an admin to consent.",
    },
    {
      id: "save-client",
      title: "Save the OAuth client in Jarela",
      description:
        "Propose enabling the integration. The user pastes Application (client) ID and the client secret value. " +
        "Both are stored encrypted at rest.",
      proposes: "enable_integration",
    },
    {
      id: "authorize",
      title: "Run the OAuth consent flow",
      description:
        "Once client credentials are saved, propose start_oauth. The user approves, Microsoft's consent " +
        "screen opens in a new tab, and a refresh_token is captured on success.",
      proposes: "start_oauth",
      verify: { tool: "outlook_list_folders" },
    },
  ],
  troubleshooting: [
    {
      when: "consent fails with AADSTS50011 redirect_uri mismatch",
      say:
        "The redirect URI in the Azure app registration doesn't match. Open the app → Authentication, " +
        "and verify the Web redirect URI matches exactly (scheme, host, port, path).",
    },
    {
      when: "token endpoint returns AADSTS900144 'scope' missing",
      say:
        "Microsoft's v2 endpoint requires the scope parameter on every token call. This is a Jarela bug " +
        "— file an issue. Workaround: re-run start_oauth, the consent flow includes the scope.",
    },
    {
      when: "tool returns 403 InsufficientScope",
      say:
        "The user consented to fewer scopes than the integration needs. Propose start_oauth — the " +
        "consent screen will re-prompt for the missing permission.",
    },
    {
      when: "M365 work account fails with 'admin consent required'",
      say:
        "The tenant admin has restricted user consent. Either ask the admin to grant tenant-wide " +
        "consent for the Jarela app registration, or use a personal Microsoft account instead.",
    },
  ],
};
