/**
 * Default LangChain tool packages that ship with Jarela.
 *
 * These packages are bundled as
 * regular dependencies. Each one used to be hardwired at module load via
 * `lib/tools/builtin-langchain-packages.ts` so operators could not turn
 * them off; this module replaces that wiring with a runtime registry
 * that honours the `disabled_packages` SQLite store. Operators can now
 * disable any default the same way they manage user-installed manifests.
 *
 * The `register()` call returns an unregister handle so the API layer
 * can flip a package off without restarting the process. Re-enabling
 * after a disable invokes `register()` again on the same descriptor.
 */
import {
  atlassianReadTools,
  atlassianWriteTools,
  atlassianExecuteTools,
  setAuthResolver as setAtlassianAuthResolver,
  resolveAtlassianAuthFromEnv,
  type AtlassianAuth,
} from "@circuitwall/atlassian-langchain";
import {
  githubReadTools,
  githubWriteTools,
  githubExecuteTools,
  setAuthResolver as setGithubAuthResolver,
  resolveGithubAuthFromEnv,
  type GitHubAuth,
} from "@circuitwall/github-langchain";
import {
  jiraAlignReadTools,
  jiraAlignWriteTools,
  jiraAlignExecuteTools,
  setAuthResolver as setJiraAlignAuthResolver,
  resolveJiraAlignAuthFromEnv,
  type JiraAlignAuth,
} from "@circuitwall/jira-align-langchain";
import {
  icloudReadTools,
  icloudWriteTools,
  icloudExecuteTools,
  setAuthResolver as setICloudAuthResolver,
  resolveICloudAuthFromEnv,
  type ICloudAuth,
} from "@circuitwall/icloud-langchain";

import {
  registerLangChainPackage,
  type RegisteredPackage,
} from "./langchain-package";
import { setPackageAuthResolver } from "./auth-registry";
import { isPackageDisabled } from "@/lib/stores/disabled-packages";
import type { BuiltinCategory } from "./registry";

export interface DefaultPackageDescriptor {
  /** Stable id used in the disable store and API surface. */
  id: string;
  /** Display name for the UI. */
  label: string;
  /** Category this package fills in the Agent editor. */
  category: BuiltinCategory;
  /** Integration id used for credentials lookup. */
  integrationId: string;
  /** npm package name, surfaced for transparency. */
  npmPackage: string;
  /** Per-capability tool counts surfaced in the UI. */
  toolCounts: { read: number; write: number; execute: number };
  /** Human-readable summary of what this package brings. */
  description: string;
  /**
   * Wire the package up. Each descriptor holds its own typed call so the
   * generic TAuth never has to escape into a shared union.
   */
  register: () => RegisteredPackage<unknown>;
}

const DESCRIPTORS: readonly DefaultPackageDescriptor[] = [
  {
    id: "atlassian",
    label: "Atlassian",
    category: "Atlassian",
    integrationId: "atlassian",
    npmPackage: "@circuitwall/atlassian-langchain",
    toolCounts: {
      read: atlassianReadTools.length,
      write: atlassianWriteTools.length,
      execute: atlassianExecuteTools.length,
    },
    description: "Jira issues + Confluence pages: search, read, comment, update.",
    register: () =>
      registerLangChainPackage<AtlassianAuth>({
        category: "Atlassian",
        tools: {
          read: atlassianReadTools,
          write: atlassianWriteTools,
          execute: atlassianExecuteTools,
        },
        auth: {
          integrationId: "atlassian",
          setAuthResolver: setAtlassianAuthResolver,
          resolveAuthFromEnv: resolveAtlassianAuthFromEnv,
          mapStoreFields: (raw): AtlassianAuth | null =>
            raw.url && raw.email && raw.api_token
              ? {
                  url: raw.url.replace(/\/+$/, ""),
                  email: raw.email,
                  apiToken: raw.api_token,
                }
              : null,
          notConfiguredError:
            "Atlassian not configured. Open Settings → Credentials and add your Atlassian site URL, " +
            "email, and API token. (Or set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars.)",
        },
      }),
  },
  {
    id: "github",
    label: "GitHub",
    category: "GitHub",
    integrationId: "github",
    npmPackage: "@circuitwall/github-langchain",
    toolCounts: {
      read: githubReadTools.length,
      write: githubWriteTools.length,
      execute: githubExecuteTools.length,
    },
    description: "Issues, pull requests, commits, code search via the GitHub REST API.",
    register: () =>
      registerLangChainPackage<GitHubAuth>({
        category: "GitHub",
        tools: {
          read: githubReadTools,
          write: githubWriteTools,
          execute: githubExecuteTools,
        },
        auth: {
          integrationId: "github",
          setAuthResolver: setGithubAuthResolver,
          resolveAuthFromEnv: resolveGithubAuthFromEnv,
          mapStoreFields: (raw): GitHubAuth | null =>
            raw.token ? { token: raw.token } : null,
          notConfiguredError:
            "GitHub not configured. Open Settings → Credentials and add a Personal Access Token. " +
            "Create one at github.com/settings/tokens with scopes: repo, read:org. " +
            "(Or set GITHUB_TOKEN / GH_TOKEN as an env var.)",
        },
      }),
  },
  {
    id: "jira_align",
    label: "Jira Align",
    category: "JiraAlign",
    integrationId: "jira_align",
    npmPackage: "@circuitwall/jira-align-langchain",
    toolCounts: {
      read: jiraAlignReadTools.length,
      write: jiraAlignWriteTools.length,
      execute: jiraAlignExecuteTools.length,
    },
    description: "Jira Align portfolio-level reads/writes for roadmaps and initiatives.",
    register: () =>
      registerLangChainPackage<JiraAlignAuth>({
        category: "JiraAlign",
        tools: {
          read: jiraAlignReadTools,
          write: jiraAlignWriteTools,
          execute: jiraAlignExecuteTools,
        },
        auth: {
          integrationId: "jira_align",
          setAuthResolver: setJiraAlignAuthResolver,
          resolveAuthFromEnv: resolveJiraAlignAuthFromEnv,
          mapStoreFields: (raw): JiraAlignAuth | null =>
            raw.url && raw.api_token
              ? {
                  url: raw.url.replace(/\/+$/, ""),
                  apiToken: raw.api_token,
                }
              : null,
          notConfiguredError:
            "Jira Align not configured. Open Settings → Credentials and add your Jira Align " +
            "instance URL and API token. (Or set JIRA_ALIGN_URL / JIRA_ALIGN_TOKEN env vars.)",
        },
      }),
  },
  ...buildICloudDescriptors(),
];

// iCloud ships one npm package that spans three domains (Mail / Calendar
// / Reminders). Rather than one catch-all "iCloud" category, expose one
// descriptor per domain so the tools land under their functional category
// (Mail, Calendar, Tasks) next to Gmail / Outlook / MS To-Do. All three
// share the same auth bridge — the credential resolver just gets set
// three times with the same closure, which is idempotent.
function buildICloudDescriptors(): readonly DefaultPackageDescriptor[] {
  const byDomain = (
    prefix: "icloud_mail_" | "icloud_calendar_" | "icloud_reminders_",
  ) => ({
    read: icloudReadTools.filter((t) => t.name.startsWith(prefix)),
    write: icloudWriteTools.filter((t) => t.name.startsWith(prefix)),
    execute: icloudExecuteTools.filter((t) => t.name.startsWith(prefix)),
  });

  const icloudAuth = {
    integrationId: "icloud",
    setAuthResolver: setICloudAuthResolver,
    resolveAuthFromEnv: resolveICloudAuthFromEnv,
    mapStoreFields: (raw: Record<string, string>): ICloudAuth | null =>
      raw.apple_id && raw.app_password
        ? { appleId: raw.apple_id, appPassword: raw.app_password }
        : null,
    notConfiguredError:
      "iCloud not configured. Open Settings → Credentials and add your Apple ID + " +
      "app-specific password (generate one at appleid.apple.com — requires 2FA). " +
      "(Or set ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD env vars.)",
  } as const;

  const mail = byDomain("icloud_mail_");
  const calendar = byDomain("icloud_calendar_");
  const reminders = byDomain("icloud_reminders_");

  return [
    {
      id: "icloud_mail",
      label: "iCloud Mail",
      category: "Mail",
      integrationId: "icloud",
      npmPackage: "@circuitwall/icloud-langchain",
      toolCounts: {
        read: mail.read.length,
        write: mail.write.length,
        execute: mail.execute.length,
      },
      description:
        "iCloud Mail (IMAP): list folders and messages, read message bodies, draft, " +
        "move, flag, and trash mail. Drafts only — cannot send mail.",
      register: () =>
        registerLangChainPackage<ICloudAuth>({
          category: "Mail",
          tools: mail,
          auth: icloudAuth,
        }),
    },
    {
      id: "icloud_calendar",
      label: "iCloud Calendar",
      category: "Calendar",
      integrationId: "icloud",
      npmPackage: "@circuitwall/icloud-langchain",
      toolCounts: {
        read: calendar.read.length,
        write: calendar.write.length,
        execute: calendar.execute.length,
      },
      description:
        "iCloud Calendar (CalDAV): list calendars and events, and create / update / delete events.",
      register: () =>
        registerLangChainPackage<ICloudAuth>({
          category: "Calendar",
          tools: calendar,
          auth: icloudAuth,
        }),
    },
    {
      id: "icloud_tasks",
      label: "iCloud Reminders",
      category: "Tasks",
      integrationId: "icloud",
      npmPackage: "@circuitwall/icloud-langchain",
      toolCounts: {
        read: reminders.read.length,
        write: reminders.write.length,
        execute: reminders.execute.length,
      },
      description:
        "iCloud Reminders (VTODO): list reminder lists and reminders, create new " +
        "reminders, and mark them complete.",
      register: () =>
        registerLangChainPackage<ICloudAuth>({
          category: "Tasks",
          tools: reminders,
          auth: icloudAuth,
        }),
    },
  ];
}

const handles = new Map<string, RegisteredPackage<unknown>>();

/** Register every default package whose disable flag is unset. Idempotent. */
export function registerDefaultPackages(): void {
  for (const descriptor of DESCRIPTORS) {
    if (handles.has(descriptor.id)) continue;
    if (isPackageDisabled(descriptor.id)) continue;
    registerOne(descriptor);
  }
}

/** Catalogue used by the API + UI; status reflects the live registry. */
export interface DefaultPackageInfo {
  id: string;
  label: string;
  category: BuiltinCategory;
  integrationId: string;
  npmPackage: string;
  toolCounts: { read: number; write: number; execute: number };
  description: string;
  enabled: boolean;
}

export function listDefaultPackages(): DefaultPackageInfo[] {
  return DESCRIPTORS.map((d) => ({
    id: d.id,
    label: d.label,
    category: d.category,
    integrationId: d.integrationId,
    npmPackage: d.npmPackage,
    toolCounts: d.toolCounts,
    description: d.description,
    enabled: !isPackageDisabled(d.id),
  }));
}

export function findDefaultPackage(id: string): DefaultPackageDescriptor | null {
  return DESCRIPTORS.find((d) => d.id === id) ?? null;
}

/**
 * Register or unregister a single default package on demand. Used by
 * the API toggle endpoint so a flip takes effect without a restart.
 */
export function setDefaultPackageEnabled(id: string, enabled: boolean): boolean {
  const descriptor = findDefaultPackage(id);
  if (!descriptor) return false;
  if (enabled) {
    if (!handles.has(id)) registerOne(descriptor);
  } else {
    const handle = handles.get(id);
    if (handle) {
      handle.unregister();
      handles.delete(id);
    }
  }
  return true;
}

function registerOne(descriptor: DefaultPackageDescriptor): void {
  const handle = descriptor.register();
  handles.set(descriptor.id, handle);
  setPackageAuthResolver(descriptor.integrationId, handle.resolveAuth);
}

/** @internal — test-only. */
export function _resetDefaultPackages(): void {
  for (const handle of handles.values()) handle.unregister();
  handles.clear();
}
