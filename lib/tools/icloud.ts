/**
 * Native iCloud tools — thin Jarela wrapper around
 * `@circuitwall/icloud-langchain`.
 *
 * Auth uses Apple ID + an app-specific password (Apple does not expose
 * an OAuth REST API for IMAP/CalDAV). The credential resolver here
 * shares the same env → integrations-store fallback used by the other
 * Circuit Wall packages.
 *
 * The package ships 17 tools across Mail (IMAP), Calendar (CalDAV), and
 * Reminders (VTODO). We register them under three separate categories
 * so the Agent editor surfaces them next to Outlook Mail / Outlook
 * Calendar / Microsoft To Do rather than dumping everything under one
 * bucket. The credential bridge is wired on the first call; the second
 * and third calls reuse the same `setAuthResolver` slot (idempotent —
 * same closure, same auth shape) since the package has a single
 * process-wide resolver.
 */
import {
  icloudMailListFoldersTool,
  icloudMailListMessagesTool,
  icloudMailGetMessageTool,
  icloudMailCreateDraftTool,
  icloudMailMoveMessageTool,
  icloudMailFlagMessageTool,
  icloudMailDeleteMessageTool,
  icloudCalendarListCalendarsTool,
  icloudCalendarListEventsTool,
  icloudCalendarGetEventTool,
  icloudCalendarCreateEventTool,
  icloudCalendarUpdateEventTool,
  icloudCalendarDeleteEventTool,
  icloudRemindersListListsTool,
  icloudRemindersListTool,
  icloudRemindersCreateTool,
  icloudRemindersCompleteTool,
  setAuthResolver,
  resolveICloudAuthFromEnv,
  type ICloudAuth,
} from "@circuitwall/icloud-langchain";
import { registerLangChainPackage } from "./langchain-package";

const ICLOUD_NOT_CONFIGURED =
  "iCloud is not configured. Open Settings → Credentials → iCloud and add your Apple ID " +
  "and an app-specific password (generate one at appleid.apple.com → Sign-In and Security " +
  "→ App-Specific Passwords; 2FA must be enabled on your Apple ID). Or set the " +
  "ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD environment variables.";

const mapStoreFields = (raw: Record<string, string>): ICloudAuth | null => {
  const appleId = raw.apple_id?.trim();
  const appPassword = raw.app_password?.trim();
  if (!appleId || !appPassword) return null;
  return { appleId, appPassword };
};

const authBridge = {
  integrationId: "icloud",
  setAuthResolver,
  resolveAuthFromEnv: resolveICloudAuthFromEnv,
  mapStoreFields,
  notConfiguredError: ICLOUD_NOT_CONFIGURED,
} as const;

// Mail (IMAP) — drafts only, never sends.
const mail = registerLangChainPackage<ICloudAuth>({
  category: "Mail",
  tools: {
    read: [icloudMailListFoldersTool, icloudMailListMessagesTool, icloudMailGetMessageTool],
    write: [icloudMailCreateDraftTool, icloudMailMoveMessageTool, icloudMailFlagMessageTool],
    execute: [icloudMailDeleteMessageTool],
  },
  auth: authBridge,
});

// Calendar (CalDAV).
registerLangChainPackage({
  category: "Calendar",
  tools: {
    read: [icloudCalendarListCalendarsTool, icloudCalendarListEventsTool, icloudCalendarGetEventTool],
    write: [icloudCalendarCreateEventTool, icloudCalendarUpdateEventTool],
    execute: [icloudCalendarDeleteEventTool],
  },
});

// Reminders (VTODO).
registerLangChainPackage({
  category: "Tasks",
  tools: {
    read: [icloudRemindersListListsTool, icloudRemindersListTool],
    write: [icloudRemindersCreateTool, icloudRemindersCompleteTool],
  },
});

// Exposed for the integrations test endpoint, matching the
// gmail/outlook/ms-todo `_resolveXxxAuth` probe convention.
export function _resolveIcloudAuth(): ICloudAuth | { error: string } {
  return mail.resolveAuth();
}
