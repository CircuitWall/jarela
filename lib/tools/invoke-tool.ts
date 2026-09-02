import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import {
  applyAgentPermissionsToCatalog,
  executeTool,
  getAllToolCatalogAsync,
  type ToolCatalogEntry,
} from "./index";
import { getAgentConfig, getAgentTools } from "@/lib/stores/agent-configs";
import { getThread } from "@/lib/stores/threads";

type Permission = "enabled" | "disabled" | "unavailable";

// Reasons that mean "permitted, just not bound to the model this turn".
// Everything else — agent_not_allowed, category_disabled, dropin_tool_disabled
// — is a real denial and still rejects.
const PROXY_REACHABLE_REASONS: ReadonlySet<string> = new Set([
  "provider_tool_limit",
  "proxy_only",
]);

function isProxyReachable(reason: string | null | undefined): boolean {
  return typeof reason === "string" && PROXY_REACHABLE_REASONS.has(reason);
}

interface RunPermissionEntry {
  name?: unknown;
  permission?: unknown;
  permission_reason?: unknown;
}

interface InvocationResult {
  ok: boolean;
  tool: string;
  status: "done" | "rejected" | "error";
  result?: unknown;
  error?: string;
  error_code?: string;
  permission?: Permission;
  permission_reason?: string | null;
}

function getThreadId(config?: RunnableConfig): string | undefined {
  const value = config?.configurable?.thread_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentFromConfig(config?: RunnableConfig) {
  const threadId = getThreadId(config);
  if (!threadId) return null;
  const thread = getThread(threadId);
  if (!thread?.agent_id) return null;
  return getAgentConfig(thread.agent_id);
}

function toolCredentialsFromConfig(config?: RunnableConfig): Readonly<Record<string, string>> | undefined {
  const runConfig = config?.configurable?.agent_run_config as { tool_credentials?: unknown } | undefined;
  const value = config?.configurable?.tool_credentials ?? runConfig?.tool_credentials;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function runPermissionMapFromConfig(config?: RunnableConfig): Map<string, { permission: Permission; reason: string | null }> {
  const runConfig = config?.configurable?.agent_run_config as { tool_permission_map?: unknown } | undefined;
  const raw = config?.configurable?.tool_permission_map ?? runConfig?.tool_permission_map;
  const out = new Map<string, { permission: Permission; reason: string | null }>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as RunPermissionEntry[]) {
    if (
      typeof entry.name === "string"
      && (entry.permission === "enabled" || entry.permission === "disabled" || entry.permission === "unavailable")
    ) {
      out.set(entry.name, {
        permission: entry.permission,
        reason: typeof entry.permission_reason === "string" ? entry.permission_reason : null,
      });
    }
  }
  return out;
}

function reject(toolName: string, error: string, errorCode: string, entry?: ToolCatalogEntry): string {
  const body: InvocationResult = {
    ok: false,
    tool: toolName,
    status: "rejected",
    error,
    error_code: errorCode,
    permission: entry?.permission,
    permission_reason: entry?.permission_reason ?? null,
  };
  return JSON.stringify(body);
}

async function resolveTargetPermission(
  toolName: string,
  config?: RunnableConfig,
): Promise<{ ok: true; entry: ToolCatalogEntry } | { ok: false; response: string }> {
  if (toolName === "invoke_tool") {
    return {
      ok: false,
      response: reject(toolName, "invoke_tool cannot invoke itself", "recursive_invoke_tool"),
    };
  }

  const catalog = await getAllToolCatalogAsync();
  const agentCfg = agentFromConfig(config);
  const permissionMap = applyAgentPermissionsToCatalog(catalog, agentCfg);
  const entry = permissionMap.find((toolEntry) => toolEntry.name === toolName);
  if (!entry) {
    return {
      ok: false,
      response: reject(toolName, `Unknown tool: ${toolName}`, "unknown_tool"),
    };
  }

  const runOverlay = runPermissionMapFromConfig(config).get(toolName);
  if (runOverlay && runOverlay.permission !== "enabled" && !isProxyReachable(runOverlay.reason)) {
    return {
      ok: false,
      response: reject(
        toolName,
        `Tool "${toolName}" is not executable in this run (${runOverlay.reason ?? runOverlay.permission})`,
        runOverlay.permission === "unavailable" ? "tool_unavailable" : "tool_not_allowed",
        { ...entry, permission: runOverlay.permission, permission_reason: runOverlay.reason },
      ),
    };
  }

  if (entry.permission !== "enabled") {
    return {
      ok: false,
      response: reject(
        toolName,
        `Tool "${toolName}" is not enabled for this agent (${entry.permission_reason ?? entry.permission})`,
        entry.permission === "unavailable" ? "tool_unavailable" : "tool_not_allowed",
        entry,
      ),
    };
  }

  if (agentCfg && !getAgentTools(agentCfg).includes(toolName) && entry.permission_reason !== "basic_default") {
    return {
      ok: false,
      response: reject(toolName, `Tool "${toolName}" is not enabled for this agent`, "tool_not_allowed", entry),
    };
  }

  return { ok: true, entry };
}

// Models on schema-restricted providers can only fill `args_json`; models on
// permissive ones may still send `args`. Accept either, preferring whichever
// actually carries content.
function resolveArgs(
  args: Record<string, unknown> | undefined,
  argsJson: string | undefined,
): Record<string, unknown> {
  if (args && Object.keys(args).length > 0) return args;
  const trimmed = argsJson?.trim();
  if (!trimmed) return args ?? {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("args_json must be a JSON object string, e.g. '{\"query\":\"hello\"}'");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("args_json must decode to a JSON object, not an array or scalar");
  }
  return parsed as Record<string, unknown>;
}

export const invokeToolTool = tool(
  async ({ name, args, args_json }, config?: RunnableConfig) => {
    const toolName = name.trim();
    const permission = await resolveTargetPermission(toolName, config);
    if (!permission.ok) return permission.response;

    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveArgs(args, args_json);
    } catch (err) {
      return reject(toolName, err instanceof Error ? err.message : String(err), "bad_args_json");
    }

    try {
      const result = await executeTool(toolName, resolvedArgs, {
        thread_id: getThreadId(config),
        tool_credentials: toolCredentialsFromConfig(config),
      });
      return JSON.stringify({
        ok: true,
        tool: toolName,
        status: "done",
        result,
      } satisfies InvocationResult);
    } catch (err) {
      return JSON.stringify({
        ok: false,
        tool: toolName,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        error_code: "target_tool_failed",
      } satisfies InvocationResult);
    }
  },
  {
    name: "invoke_tool",
    description:
      "Execute a permitted tool by name. Use this after list_tools finds a tool that is permitted for this agent but was not directly loaded this turn, especially when permission_reason='proxy_only' or 'provider_tool_limit'. " +
      "Pass the target's arguments as args_json: a JSON object encoded as a string, e.g. args_json='{\"query\":\"from:alice\"}'. Send args_json='{}' when the target takes no arguments. " +
      "Never use invoke_tool to call invoke_tool itself; call already-loaded tools directly instead of wrapping them. " +
      "This does not bypass permissions, disabled categories, unavailable MCP servers, disabled drop-in tools, or credential requirements. Call list_tools with include_schema=true when you need the target tool's argument schema.",
    schema: z.object({
      name: z.string().min(1).describe("Exact target tool name from list_tools."),
      // A string carries arguments through every provider. Gemini strips
      // `additionalProperties` from tool schemas, which turns a free-form
      // object into one the model can only ever emit as `{}`.
      args_json: z
        .string()
        .optional()
        .describe("Target tool arguments as a JSON object string, matching its list_tools include_schema=true schema."),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Deprecated: use args_json. Structured form of the same arguments."),
    }),
  },
);

registerLangChainPackage({
  category: "Config",
  tools: { execute: [invokeToolTool] },
});
