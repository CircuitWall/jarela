import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const gmailManifest: IntegrationManifest = {
  id: "gmail",
  name: "Gmail + Google Calendar",
  summary:
    "Lets the agent search/read mail, create drafts (never send), label/archive, " +
    "and read or modify calendar events. Drafts-only is a deliberate safety choice — " +
    "this integration intentionally cannot send mail on the user's behalf.",
  category: "mail",
  prerequisites: [
    {
      check: "oauth_app",
      detail:
        "A Google Cloud project with the Gmail API and Calendar API enabled, plus a " +
        "Web Application OAuth client. The client_id and client_secret are required " +
        "BEFORE the agent can propose start_oauth.",
      docs_url: "https://console.cloud.google.com/apis/credentials",
    },
    {
      check: "custom",
      detail:
        "The OAuth client's authorized redirect URI must match where Jarela is reachable. " +
        "For local use that's typically http://localhost:4312/api/v1/integrations/gmail/oauth/callback.",
    },
  ],
  steps: [
    {
      id: "create-cloud-project",
      title: "Create or pick a Google Cloud project",
      description:
        "Open console.cloud.google.com, create a new project (or pick an existing one). " +
        "This is purely an instructional step — Jarela can't create the project for the user.",
      docs_url: "https://console.cloud.google.com/projectcreate",
    },
    {
      id: "enable-apis",
      title: "Enable the Gmail and Calendar APIs",
      description:
        "In the project, open APIs & Services → Library, search for Gmail API and Google Calendar API, " +
        "and enable both. The Calendar scope is required for calendarList.list to return calendars.",
    },
    {
      id: "create-oauth-client",
      title: "Create an OAuth 2.0 Client ID",
      description:
        "APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application. " +
        "Add the redirect URI from the prerequisite above. Copy client_id and client_secret.",
      docs_url: "https://console.cloud.google.com/apis/credentials",
    },
    {
      id: "save-client",
      title: "Save the OAuth client in Jarela",
      description:
        "Propose enabling the integration. The user will paste client_id and client_secret " +
        "into the secure form. Both are stored encrypted at rest.",
      proposes: "enable_integration",
    },
    {
      id: "authorize",
      title: "Run the OAuth consent flow",
      description:
        "Once client_id and client_secret are saved, propose start_oauth. The user approves, a " +
        "Google consent screen opens in a new tab, and on success a refresh_token is captured " +
        "automatically. The agent can then use gmail_* and calendar_* tools.",
      proposes: "start_oauth",
      verify: { tool: "gmail_list_labels" },
    },
  ],
  troubleshooting: [
    {
      when: "OAuth redirect returns 'redirect_uri_mismatch'",
      say:
        "The redirect URI in the Google Cloud OAuth client doesn't match what Jarela sent. " +
        "Open the OAuth client in Cloud Console → Authorized redirect URIs, and add the URI exactly " +
        "as shown in the error page (including the port).",
    },
    {
      when: "OAuth consent screen says 'access_denied'",
      say:
        "The Google project is in 'Testing' mode and the user's email isn't on the allowed test users " +
        "list. Either add their email under OAuth consent screen → Test users, or publish the app.",
    },
    {
      when: "tool returns 403 invalid_scope or insufficient_permissions for calendar",
      say:
        "An older Gmail-only consent didn't include the Calendar scopes. Propose start_oauth again — " +
        "the new consent will request both Gmail and Calendar scopes and overwrite the refresh token.",
    },
    {
      when: "tool returns 401 invalid_grant",
      say:
        "The refresh token was revoked (often because the OAuth client_secret was rotated, or the user " +
        "revoked access at myaccount.google.com). Propose start_oauth to re-authorize.",
    },
  ],
};
