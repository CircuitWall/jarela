import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const icloudManifest: IntegrationManifest = {
  id: "icloud",
  name: "iCloud Mail + Calendar + Reminders",
  summary:
    "Lets the agent list/read iCloud Mail, create drafts (never send), move/flag/trash messages, " +
    "manage calendar events, and create/complete reminders. Drafts-only is a deliberate safety " +
    "choice — this integration intentionally cannot send mail on the user's behalf.",
  category: "mail",
  prerequisites: [
    {
      check: "custom",
      detail:
        "Two-factor authentication must be enabled on the Apple ID. App-specific passwords are " +
        "only available for accounts that protect themselves with 2FA.",
      docs_url: "https://support.apple.com/en-us/HT204915",
    },
    {
      check: "credentials",
      detail:
        "An app-specific password generated at appleid.apple.com. This is a 16-character one-off " +
        "credential that Apple issues for third-party apps; it can be revoked any time without " +
        "touching the main Apple ID password.",
      docs_url: "https://support.apple.com/en-us/HT204397",
    },
  ],
  steps: [
    {
      id: "enable-2fa",
      title: "Enable two-factor authentication on the Apple ID",
      description:
        "Open appleid.apple.com → Sign-In and Security → Two-Factor Authentication and turn it on. " +
        "This is purely an instructional step — Jarela can't toggle 2FA for the user.",
      docs_url: "https://support.apple.com/en-us/HT204915",
    },
    {
      id: "generate-app-password",
      title: "Generate an app-specific password",
      description:
        "appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate. Label it " +
        "something like 'Jarela'. Apple shows the 16-character password once — copy it into the " +
        "next step before closing the dialog.",
      docs_url: "https://support.apple.com/en-us/HT204397",
    },
    {
      id: "save-credentials",
      title: "Save the Apple ID + app-specific password in Jarela",
      description:
        "Propose enabling the integration. The user pastes their full Apple ID email and the " +
        "16-character app-specific password into the secure form. Both are stored encrypted at " +
        "rest. Dashes in the password are stripped automatically.",
      proposes: "enable_integration",
      verify: { tool: "icloud_mail_list_folders" },
    },
  ],
  troubleshooting: [
    {
      when: "tool returns AUTHENTICATIONFAILED / 401 from IMAP or CalDAV",
      say:
        "The app-specific password was revoked or the Apple ID disabled 2FA. Generate a fresh " +
        "app-specific password at appleid.apple.com and save it in Settings → Credentials → iCloud.",
    },
    {
      when: "icloud_mail_* tools return 'NO LOGIN' or 'too many requests'",
      say:
        "iCloud throttles new IMAP sessions per minute. Wait 60 seconds and retry. If it keeps " +
        "failing, regenerate the app-specific password — Apple sometimes invalidates an old one " +
        "after a security event without telling the user.",
    },
    {
      when: "icloud_calendar_list_calendars returns an empty list",
      say:
        "The user might be on a brand-new iCloud account where the calendar home set hasn't been " +
        "provisioned yet. Ask the user to open Calendar.app or icloud.com/calendar once — Apple " +
        "lazy-creates the home set on first UI use.",
    },
  ],
};
