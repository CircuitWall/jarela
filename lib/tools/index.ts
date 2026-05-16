import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";
import { memoryReadTool, memoryWriteTool, memoryListTool } from "./memory";
import { localExecTool, shellExecTool } from "./exec";
import { fileReadTool, fileWriteTool, fileEditTool } from "./files";
import { webSearchTool } from "./search";
import { webFetchTool } from "./fetch";
import { generateImageTool } from "./generate_image";
import { scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool } from "./schedule";
import { proposeConfigChangeTool, checkProposalTool } from "./propose";
import {
  jiraSearchTool, jiraGetIssueTool, jiraCreateIssueTool, jiraAddCommentTool, jiraTransitionsTool,
  confluenceSearchTool, confluenceGetPageTool,
} from "./atlassian";
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
];

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
