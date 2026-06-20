import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const icloudManifest: IntegrationManifest = {
  id: "icloud",
  name: "iCloud Mail + Calendar + Reminders",
  summary:
    "Lets the agent search and read iCloud mail (IMAP), create drafts (never send), move and " +
    "flag messages, list and modify iCloud Calendar events (CalDAV), and manage iCloud " +
    "Reminders (VTODO). Drafts-only by design — the integration intentionally cannot send mail.",
  category: "mail",
  prerequisites: [
    {
      check: "credentials",
      detail:
        "An Apple ID with two-factor authentication enabled (required to mint app-specific " +
        "passwords) and access to the iCloud Mail / Calendar / Reminders services you want " +
        "the agent to read.",
    },
    {
      check: "credentials",
      detail:
        "An app-specific password generated at appleid.apple.com → Sign-In and Security → " +
        "App-Specific Passwords. Apple shows the password once — copy it immediately. Dashes " +
        "in the value are ignored by the integration; both 'abcd-efgh-ijkl-mnop' and " +
        "'abcdefghijklmnop' work.",
      docs_url: "https://support.apple.com/en-us/102654",
    },
  ],
  steps: [
    {
      id: "enable-2fa",
      title: "Confirm two-factor authentication is enabled on your Apple ID",
      description:
        "Open Settings → [your name] → Sign-In and Security on iOS, or System Settings → " +
        "[your name] → Sign-In and Security on macOS. If 2FA is off, Apple won't let you " +
        "create an app-specific password.",
      docs_url: "https://support.apple.com/en-us/102660",
    },
    {
      id: "create-app-password",
      title: "Generate an app-specific password",
      description:
        "Sign in at appleid.apple.com → Sign-In and Security → App-Specific Passwords → " +
        "Generate an app-specific password. Label it 'Jarela' and copy the value — Apple " +
        "only shows it once. You can revoke it anytime from the same page.",
      docs_url: "https://support.apple.com/en-us/102654",
    },
    {
      id: "save-credentials",
      title: "Save the credentials in Jarela",
      description:
        "Propose enabling the integration. The user provides their Apple ID (full email) " +
        "and the app-specific password. Both are stored encrypted at rest.",
      proposes: "enable_integration",
      verify: { tool: "icloud_mail_list_folders" },
    },
  ],
  troubleshooting: [
    {
      when: "IMAP login fails with 'Invalid credentials' or 'Authentication failed'",
      say:
        "Either the Apple ID is wrong, the app-specific password was revoked, or 2FA was " +
        "disabled (which invalidates all app-specific passwords). Ask the user to regenerate " +
        "a fresh app-specific password at appleid.apple.com → Sign-In and Security → " +
        "App-Specific Passwords and re-enter it.",
    },
    {
      when: "CalDAV PROPFIND returns 401 Unauthorized",
      say:
        "Same root cause as the IMAP failure — the app-specific password isn't accepted. " +
        "iCloud requires the same app-specific password for both IMAP and CalDAV; the " +
        "regular Apple ID password will NOT work even if 2FA is off.",
    },
    {
      when: "tool returns 'No \\Trash folder found' when deleting a message",
      say:
        "Some localised iCloud accounts label the trash mailbox differently. Ask the user " +
        "which folder name they see in iCloud Mail for deleted items, then call " +
        "icloud_mail_move_message explicitly with that folder name instead of " +
        "icloud_mail_delete_message.",
    },
    {
      when: "creating an event returns 'invalid date-time value'",
      say:
        "iCloud's CalDAV server expects RFC 5545 datetimes. Pass ISO 8601 strings " +
        "(2026-06-20T14:00:00Z) for timed events and YYYY-MM-DD with all_day=true for " +
        "all-day events. Local-zone timestamps without a Z suffix can be ambiguous.",
    },
  ],
};
