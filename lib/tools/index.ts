import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";
import { memoryReadTool, memoryWriteTool, memoryListTool } from "./memory";
import { localExecTool, shellExecTool } from "./exec";
import {
  fileReadTool, fileWriteTool, fileEditTool, fileMoveTool, fileListTool,
  fileMkdirTool, fileDeleteTool, fileCopyTool, fileStatTool,
} from "./files";
import { webSearchTool } from "./search";
import { webFetchTool } from "./fetch";
import { generateImageTool } from "./generate_image";
import { generateVoiceTool } from "./generate_voice";
import { scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool } from "./schedule";
import { proposeConfigChangeTool, checkProposalTool } from "./propose";
import { listIntegrationsTool, getIntegrationSetupTool } from "./integrations";
import {
  jiraSearchTool, jiraGetIssueTool, jiraCreateIssueTool, jiraAddCommentTool, jiraTransitionsTool,
  jiraUpdateIssueTool, jiraFindUserTool,
  confluenceSearchTool, confluenceGetPageTool,
} from "./atlassian";
import {
  jiraAlignGetItemTool, jiraAlignSearchItemsTool, jiraAlignListChildrenTool,
  jiraAlignCreateItemTool, jiraAlignUpdateItemTool, jiraAlignTransitionItemTool,
  jiraAlignDeleteItemTool, jiraAlignAddCommentTool,
} from "./jira-align";
import {
  githubSearchIssuesTool, githubGetIssueTool, githubCreateIssueTool, githubAddCommentTool,
  githubListPullsTool, githubGetPullTool, githubGetRepoTool,
} from "./github";
import {
  gmailSearchTool, gmailGetMessageTool, gmailListLabelsTool,
  gmailModifyMessageTool, gmailCreateDraftTool, gmailTrashMessageTool,
} from "./gmail";
import {
  calendarListCalendarsTool, calendarListEventsTool, calendarGetEventTool,
  calendarCreateEventTool, calendarUpdateEventTool, calendarDeleteEventTool,
} from "./calendar";
import {
  outlookSearchTool, outlookGetMessageTool, outlookListFoldersTool,
  outlookModifyMessageTool, outlookCreateDraftTool, outlookTrashMessageTool,
} from "./outlook";
import {
  outlookCalendarListCalendarsTool, outlookCalendarListEventsTool,
  outlookCalendarGetEventTool, outlookCalendarCreateEventTool,
  outlookCalendarUpdateEventTool, outlookCalendarDeleteEventTool,
} from "./outlook-calendar";
import { getUserLocationTool } from "./location";
import { getMcpTools } from "@/lib/mcp/client";
import { loadExternalTools, type ExtensionLoadError } from "./external";
import type { OpenAITool, ToolContext, ToolParamSchema } from "./types";
import type { ToolPolicy } from "@/lib/agents/base";

export * from "./types";
export { TOOLS_DIR, type ExtensionLoadError } from "./external";

// Category assignments drive the grouped per-section UI in AgentEditor so
// the user can flip an entire capability on/off without clicking every tool.
// MCP tools default to "MCP" (overridable per-server in the future).
//
// To add a new tool: copy lib/tools/template.ts, implement the func, then
// append it under the appropriate category below. A single source of truth
// — no parallel name→category map to keep in sync.
export type ToolCategory =
  | "Memory" | "Files" | "Shell" | "Web" | "Images" | "Voice"
  | "Schedule" | "Atlassian" | "JiraAlign" | "GitHub" | "Mail" | "Calendar" | "Config" | "MCP";

// Optional parent group rendered above categories in the Agent editor. The
// idea is that "Atlassian" and "GitHub" are both Work tools that share an
// auth model (corporate PAT/OAuth) — collapsing them under a single header
// keeps the editor scannable as we add more vendor-native tools. Null = flat.
export type ToolGroup = "Work" | null;
const CATEGORY_GROUPS: Record<Exclude<ToolCategory, "MCP">, ToolGroup> = {
  Memory: null, Files: null, Shell: null, Web: null, Images: null, Voice: null,
  Schedule: null, Config: null, Mail: null, Calendar: null,
  Atlassian: "Work", JiraAlign: "Work", GitHub: "Work",
};

const TOOLS_BY_CATEGORY: Record<Exclude<ToolCategory, "MCP">, StructuredToolInterface[]> = {
  Memory: [memoryReadTool, memoryWriteTool, memoryListTool],
  Shell: [localExecTool, shellExecTool],
  Files: [
    fileReadTool, fileWriteTool, fileEditTool, fileMoveTool, fileCopyTool,
    fileDeleteTool, fileListTool, fileMkdirTool, fileStatTool,
  ],
  Web: [webSearchTool, webFetchTool, getUserLocationTool],
  Images: [generateImageTool],
  Voice: [generateVoiceTool],
  Schedule: [scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool],
  Config: [
    proposeConfigChangeTool, checkProposalTool,
    listIntegrationsTool, getIntegrationSetupTool,
  ],
  Atlassian: [
    jiraSearchTool, jiraGetIssueTool, jiraFindUserTool,
    jiraCreateIssueTool, jiraUpdateIssueTool, jiraAddCommentTool, jiraTransitionsTool,
    confluenceSearchTool, confluenceGetPageTool,
  ],
  JiraAlign: [
    jiraAlignGetItemTool, jiraAlignSearchItemsTool, jiraAlignListChildrenTool,
    jiraAlignCreateItemTool, jiraAlignUpdateItemTool, jiraAlignTransitionItemTool,
    jiraAlignDeleteItemTool, jiraAlignAddCommentTool,
  ],
  GitHub: [
    githubSearchIssuesTool, githubGetIssueTool, githubCreateIssueTool, githubAddCommentTool,
    githubListPullsTool, githubGetPullTool, githubGetRepoTool,
  ],
  Mail: [
    gmailSearchTool, gmailGetMessageTool, gmailListLabelsTool,
    gmailModifyMessageTool, gmailCreateDraftTool, gmailTrashMessageTool,
    outlookSearchTool, outlookGetMessageTool, outlookListFoldersTool,
    outlookModifyMessageTool, outlookCreateDraftTool, outlookTrashMessageTool,
  ],
  Calendar: [
    calendarListCalendarsTool, calendarListEventsTool, calendarGetEventTool,
    calendarCreateEventTool, calendarUpdateEventTool, calendarDeleteEventTool,
    outlookCalendarListCalendarsTool, outlookCalendarListEventsTool,
    outlookCalendarGetEventTool, outlookCalendarCreateEventTool,
    outlookCalendarUpdateEventTool, outlookCalendarDeleteEventTool,
  ],
};

const ALL_TOOLS: StructuredToolInterface[] = Object.values(TOOLS_BY_CATEGORY).flat();
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(ALL_TOOLS.map((t) => t.name));

const TOOL_CATEGORY: Map<string, ToolCategory> = new Map(
  (Object.entries(TOOLS_BY_CATEGORY) as Array<[ToolCategory, StructuredToolInterface[]]>)
    .flatMap(([cat, tools]) => tools.map((t) => [t.name, cat] as const)),
);

// Per-call recompute so files dropped in ~/.jarela/tools/ are picked up
// without restart. loadExternalTools cache-busts require() per file.
function loadExternal() {
  return loadExternalTools(BUILTIN_TOOL_NAMES);
}

export function getToolCategory(name: string, source: "builtin" | "mcp"): ToolCategory {
  const builtin = TOOL_CATEGORY.get(name);
  if (builtin) return builtin;
  const ext = loadExternal().categories.get(name);
  if (ext) return ext;
  return source === "mcp" ? "MCP" : "Config";
}

export function getToolGroup(name: string, source: "builtin" | "mcp"): ToolGroup {
  const cat = getToolCategory(name, source);
  if (cat === "MCP") return null;
  return CATEGORY_GROUPS[cat] ?? null;
}

function applyPolicy(
  tools: StructuredToolInterface[],
  policy?: ToolPolicy,
): StructuredToolInterface[] {
  const allowSet = policy?.allow?.length ? new Set(policy.allow) : null;
  const denySet = policy?.deny?.length ? new Set(policy.deny) : null;
  return tools.filter((t) => {
    if (allowSet && !allowSet.has(t.name)) return false;
    if (denySet && denySet.has(t.name)) return false;
    return true;
  });
}

// Synchronous: built-in + external tools (no MCP). Used by GET /api/v1/tools
// and any code path that can't await.
export function getAllTools(policy?: ToolPolicy): StructuredToolInterface[] {
  return applyPolicy([...ALL_TOOLS, ...loadExternal().tools], policy);
}

// Async: built-in + external + MCP tools.
// Use this anywhere the agent might invoke tools (createReactAgent input).
// External tools are loaded per-call (hot-reload). MCP tools are cached by
// lib/mcp/client.ts and only re-resolved when the mcp_servers table changes.
export async function getAllToolsAsync(policy?: ToolPolicy): Promise<StructuredToolInterface[]> {
  let mcpTools: StructuredToolInterface[] = [];
  try {
    mcpTools = await getMcpTools();
  } catch (err) {
    console.error("[tools] MCP load failed, continuing with built-ins only:", err);
  }
  return applyPolicy([...ALL_TOOLS, ...loadExternal().tools, ...mcpTools], policy);
}

export function toOpenAITools(tools: StructuredToolInterface[]): OpenAITool[] {
  return tools.map((t) => {
    const oai = convertToOpenAITool(t);
    return {
      type: "function",
      function: {
        name: oai.function.name,
        description: oai.function.description ?? "",
        parameters: oai.function.parameters as ToolParamSchema,
      },
    };
  });
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {},
): Promise<unknown> {
  let t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) {
    t = loadExternal().tools.find((x) => x.name === name);
  }
  if (!t) throw new Error(`Unknown tool: ${name}`);

  const config: RunnableConfig = context.thread_id
    ? { configurable: { thread_id: context.thread_id } }
    : {};

  const result = await t.invoke(args, config);

  // Tools return JSON strings per LangChain convention; parse back for downstream use.
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  return result;
}
