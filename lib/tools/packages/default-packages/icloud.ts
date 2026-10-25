import type { StructuredToolInterface } from "@langchain/core/tools";
import { optionalFunction, optionalTools } from "../optional-package";
import { registerLangChainPackage } from "../langchain-package";
import type { DefaultPackageDescriptor } from "./types";

const read = optionalTools<StructuredToolInterface>("@circuitwall/icloud-langchain", "icloudReadTools");
const write = optionalTools<StructuredToolInterface>("@circuitwall/icloud-langchain", "icloudWriteTools");
const execute = optionalTools<StructuredToolInterface>("@circuitwall/icloud-langchain", "icloudExecuteTools");
const setAuthResolver = optionalFunction("@circuitwall/icloud-langchain", "setAuthResolver", () => undefined);
const resolveAuthFromEnv = optionalFunction("@circuitwall/icloud-langchain", "resolveICloudAuthFromEnv", () => ({ error: "iCloud package is not installed." }));

function byDomain(prefix: "icloud_mail_" | "icloud_calendar_" | "icloud_reminders_") {
  return {
    get read() { return read.filter((tool) => tool.name.startsWith(prefix)); },
    get write() { return write.filter((tool) => tool.name.startsWith(prefix)); },
    get execute() { return execute.filter((tool) => tool.name.startsWith(prefix)); },
  };
}

const auth = {
  integrationId: "icloud",
  setAuthResolver,
  resolveAuthFromEnv,
  mapStoreFields: (raw: Record<string, string>) => raw.apple_id && raw.app_password
    ? { appleId: raw.apple_id, appPassword: raw.app_password, mailAddress: raw.mail_address || undefined }
    : null,
  notConfiguredError:
    "iCloud not configured. Open Settings → Credentials and add your Apple ID + " +
    "app-specific password (generate one at appleid.apple.com — requires 2FA). " +
    "(Or set ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD env vars.)",
} as const;

function descriptor(
  id: string,
  label: string,
  category: "Mail" | "Calendar" | "Tasks",
  tools: ReturnType<typeof byDomain>,
  description: string,
): DefaultPackageDescriptor {
  return {
    id,
    label,
    category,
    integrationId: "icloud",
    npmPackage: "@circuitwall/icloud-langchain",
    get toolCounts() {
      return { read: tools.read.length, write: tools.write.length, execute: tools.execute.length };
    },
    description,
    register: () => registerLangChainPackage({ category, tools, auth }),
  };
}

const mail = byDomain("icloud_mail_");
const calendar = byDomain("icloud_calendar_");
const reminders = byDomain("icloud_reminders_");

export const icloudDefaultPackages: readonly DefaultPackageDescriptor[] = [
  descriptor(
    "icloud_mail",
    "iCloud Mail",
    "Mail",
    mail,
    "iCloud Mail (IMAP/SMTP): read, draft, move, flag, and trash mail; send only when explicitly requested.",
  ),
  descriptor(
    "icloud_calendar",
    "iCloud Calendar",
    "Calendar",
    calendar,
    "iCloud Calendar (CalDAV): list calendars and events, and create / update / delete events.",
  ),
  descriptor(
    "icloud_tasks",
    "iCloud Reminders",
    "Tasks",
    reminders,
    "iCloud Reminders (VTODO): list reminder lists and reminders, create new reminders, and mark them complete.",
  ),
];