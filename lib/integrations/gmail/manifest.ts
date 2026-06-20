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
      check: "credentials",
      detail:
        "A Google account whose Gmail and Calendar the agent should reach. The user clicks " +
        "Connect Gmail in the Integrations panel, signs in to Google, and grants the requested " +
        "scopes (Gmail read+modify+compose, Calendar events read+write). No Google Cloud project " +
        "or OAuth client setup is required \u2014 Jarela ships a bundled Desktop OAuth client_id " +
        "and uses PKCE (RFC 7636) as the per-flow proof. No client secret ships in the binary.",
    },
    {
      check: "oauth_app",
      detail:
        "ADVANCED ONLY: forks that prefer their own GCP project can set the env var " +
        "JARELA_GMAIL_CLIENT_ID, or paste a client_id (+ optional client_secret for Web app types) " +
        "into the integration's Advanced fields. The bundled client_id is used otherwise.",
      docs_url: "https://console.cloud.google.com/apis/credentials",
    },
  ],
  steps: [
    {
      id: "connect-gmail",
      title: "Click Connect Gmail",
      description:
        "Open Settings \u2192 Credentials \u2192 Gmail and click Connect Gmail. A Google sign-in " +
        "popup appears. Sign in, review the requested scopes (mail read/modify/compose, calendar " +
        "events read/write), and grant access. The popup closes automatically and the integration " +
        "is connected.",
      proposes: "start_oauth",
      verify: { tool: "gmail_list_labels" },
    },
  ],
  troubleshooting: [
    {
      when: "consent screen shows 'Google hasn't verified this app'",
      say:
        "Until Jarela passes Google's OAuth verification process the bundled client shows this " +
        "warning. Click Advanced \u2192 Go to Jarela (unsafe) to continue. The agent's access is " +
        "limited to exactly the scopes shown on the consent screen.",
    },
    {
      when: "OAuth consent says 'access_denied' or 'app blocked by org'",
      say:
        "The user's Google Workspace admin has blocked unverified third-party OAuth apps. The user " +
        "needs admin approval, or can switch to a BYO OAuth client in the Advanced fields using " +
        "their own GCP project.",
    },
    {
      when: "tool returns 403 invalid_scope or insufficient_permissions for calendar",
      say:
        "An older Gmail-only consent didn't include the Calendar scopes. Click Connect Gmail again \u2014 " +
        "the new consent will request both Gmail and Calendar scopes and overwrite the refresh token.",
    },
    {
      when: "tool returns 401 invalid_grant",
      say:
        "The refresh token was revoked (often because the user revoked access at " +
        "myaccount.google.com/permissions). Click Connect Gmail again to re-authorize.",
    },
  ],
};
