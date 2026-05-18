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
import { scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool } from "./schedule";
import { proposeConfigChangeTool, checkProposalTool } from "./propose";
import {
  jiraSearchTool, jiraGetIssueTool, jiraCreateIssueTool, jiraAddCommentTool, jiraTransitionsTool,
  confluenceSearchTool, confluenceGetPageTool,
} from "./atlassian";
import {
  gmailSearchTool, gmailGetMessageTool, gmailListLabelsTool,
  gmailModifyMessageTool, gmailCreateDraftTool, gmailTrashMessageTool,
} from "./gmail";
import {
  calendarListCalendarsTool, calendarListEventsTool, calendarGetEventTool,
  calendarCreateEventTool, calendarUpdateEventTool, calendarDeleteEventTool,
} from "./calendar";
import { getUserLocationTool } from "./location";
import { getMcpTools } from "@/lib/mcp/client";
import type { OpenAITool, ToolContext, ToolParamSchema } from "./types";
import type { ToolPolicy } from "@/lib/agents/base";

export * from "./types";

// To add a new tool: copy lib/tools/template.ts, implement the func, then append here.
const ALL_TOOLS: StructuredToolInterface[] = [
  memoryReadTool,
  memoryWriteTool,
  memoryListTool,
  localExecTool,
  shellExecTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileMoveTool,
  fileCopyTool,
  fileDeleteTool,
  fileListTool,
  fileMkdirTool,
  fileStatTool,
  webSearchTool,
  webFetchTool,
  generateImageTool,
  scheduleTaskTool,
  listScheduledTasksTool,
  cancelScheduledTaskTool,
  proposeConfigChangeTool,
  checkProposalTool,
  jiraSearchTool,
  jiraGetIssueTool,
  jiraCreateIssueTool,
  jiraAddCommentTool,
  jiraTransitionsTool,
  confluenceSearchTool,
  confluenceGetPageTool,
  gmailSearchTool,
  gmailGetMessageTool,
  gmailListLabelsTool,
  gmailModifyMessageTool,
  gmailCreateDraftTool,
  gmailTrashMessageTool,
  calendarListCalendarsTool,
  calendarListEventsTool,
  calendarGetEventTool,
  calendarCreateEventTool,
  calendarUpdateEventTool,
  calendarDeleteEventTool,
  getUserLocationTool,
];

// Category assignments. Drives the grouped per-section UI in AgentEditor so
// the user can flip an entire capability on/off without clicking every tool.
// MCP tools default to "MCP" (overridable per-server in the future).
export type ToolCategory =
  | "Memory" | "Files" | "Shell" | "Web" | "Images"
  | "Schedule" | "Atlassian" | "Mail" | "Calendar" | "Config" | "MCP";

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  memory_read: "Memory",
  memory_write: "Memory",
  memory_list: "Memory",
  local_exec: "Shell",
  shell_exec: "Shell",
  file_read: "Files",
  file_write: "Files",
  file_edit: "Files",
  file_move: "Files",
  file_copy: "Files",
  file_delete: "Files",
  file_list: "Files",
  file_mkdir: "Files",
  file_stat: "Files",
  web_search: "Web",
  web_fetch: "Web",
  generate_image: "Images",
  schedule_task: "Schedule",
  list_scheduled_tasks: "Schedule",
  cancel_scheduled_task: "Schedule",
  propose_config_change: "Config",
  check_proposal: "Config",
  jira_search: "Atlassian",
  jira_get_issue: "Atlassian",
  jira_create_issue: "Atlassian",
  jira_add_comment: "Atlassian",
  jira_transitions: "Atlassian",
  confluence_search: "Atlassian",
  confluence_get_page: "Atlassian",
  gmail_search: "Mail",
  gmail_get_message: "Mail",
  gmail_list_labels: "Mail",
  gmail_modify_message: "Mail",
  gmail_create_draft: "Mail",
  gmail_trash_message: "Mail",
  calendar_list_calendars: "Calendar",
  calendar_list_events: "Calendar",
  calendar_get_event: "Calendar",
  calendar_create_event: "Calendar",
  calendar_update_event: "Calendar",
  calendar_delete_event: "Calendar",
  get_user_location: "Web",
};

export function getToolCategory(name: string, source: "builtin" | "mcp"): ToolCategory {
  return TOOL_CATEGORY[name] ?? (source === "mcp" ? "MCP" : "Config");
}

const toolMap = new Map<string, StructuredToolInterface>(ALL_TOOLS.map((t) => [t.name, t]));

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

// Synchronous: built-in tools only. Used by GET /api/v1/tools and any code
// path that can't await (rare).
export function getAllTools(policy?: ToolPolicy): StructuredToolInterface[] {
  return applyPolicy(ALL_TOOLS, policy);
}

// Async: built-in tools + tools from connected MCP servers.
// Use this anywhere the agent might invoke tools (createReactAgent input).
// MCP tools are cached by lib/mcp/client.ts and only re-resolved when the
// mcp_servers table changes.
export async function getAllToolsAsync(policy?: ToolPolicy): Promise<StructuredToolInterface[]> {
  let mcpTools: StructuredToolInterface[] = [];
  try {
    mcpTools = await getMcpTools();
  } catch (err) {
    console.error("[tools] MCP load failed, continuing with built-ins only:", err);
  }
  return applyPolicy([...ALL_TOOLS, ...mcpTools], policy);
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
  const t = toolMap.get(name);
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
