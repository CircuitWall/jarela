// Public tool surface for the agent runtime.
//
// Built-in tools register themselves at module load (see ./registry.ts and
// ./builtins.ts). External tools live under JARELA_TOOLS_DIR and are
// loaded per-call (hot-reload). MCP tools come from lib/mcp/client.ts.
//
// To add a new built-in tool:
//   1. Copy lib/tools/template.ts to lib/tools/<name>.ts and implement it.
//   2. Call `registerTools("<Category>", "<read|write|execute>", [yourTool, ...])` at the bottom.
//   3. Add `import "./<name>";` to lib/tools/builtins.ts.
//
// That's it — no central array to update, no parallel category map.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";

// Side-effect import: triggers registerTools() in every built-in module.
import "./builtins";

import {
  registeredTools,
  registeredNames,
  registeredCategory,
  registeredCapability,
  registeredGroup,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./registry";
import { getMcpTools } from "@/lib/mcp/client";
import {
  loadExternalTools,
  getToolsDir,
  type ExtensionLoadError,
} from "./external";
import type { OpenAITool, ToolContext, ToolParamSchema, ToolResult } from "./types";
import type { ToolPolicy } from "@/lib/agents/base";
import { disabledCategories } from "@/lib/stores/builtin-tools";
import { runToolDispatched } from "./dispatch";
import { withToolTimeout } from "./timeout";
import { getConfig } from "@/lib/env/config";

// Wrap a StructuredTool so its .invoke() flows through the central dispatch
// chokepoint (PR-4) layered over the per-call timeout (PR-1). Without this
// wrap, only the proposals / direct-API path went through dispatch +
// timeout — the LangGraph react agent's hot path called .invoke directly
// and bypassed both. After this wrap, every tool invocation in the
// process — agent loop, executeTool, and any future caller — gets the same
// observability + deadline coverage uniformly.
//
// The wrapper preserves the tool's identity (name, description, schema)
// because LangChain's prebuilt agent serialises those for the function-
// calling payload sent to the model. We override only `invoke`.
//
// Returns the original `t` mutated in place rather than a new object so
// any reference equality elsewhere (registry maps, allowed-tools lookups)
// keeps working. Idempotent — re-wrapping a wrapped tool is a no-op.
const WRAPPED_MARK = Symbol.for("@jarela/dispatch-wrapped");

function wrapToolWithDispatch<T extends StructuredToolInterface>(t: T): T {
  type Wrapped = T & { [WRAPPED_MARK]?: true };
  const wrapped = t as Wrapped;
  if (wrapped[WRAPPED_MARK]) return t;
  const originalInvoke = t.invoke.bind(t);
  t.invoke = async (args: Parameters<T["invoke"]>[0], config?: RunnableConfig) => {
    const threadId = config?.configurable?.thread_id as string | undefined;
    const runSignal = (config as RunnableConfig & { signal?: AbortSignal })?.signal;
    const timeoutMs = getConfig().toolTimeoutMs;
    const result = await runToolDispatched(
      () => withToolTimeout(
        (signal) => originalInvoke(args, { ...config, signal }),
        { toolName: t.name, timeoutMs, runSignal },
      ),
      { toolName: t.name, threadId },
    );
    // Return the legacy raw payload shape LangChain's tool executor expects:
    // strings pass through to ToolMessage.content; objects get JSON-stringified
    // by the executor. Either way, llm.ts's tool_result handler runs JSON.parse
    // on the resulting string and consumers see the same shape they always did.
    return toLegacyShape(result);
  };
  wrapped[WRAPPED_MARK] = true;
  return t;
}

function wrapAll<T extends StructuredToolInterface>(tools: T[]): T[] {
  for (const t of tools) wrapToolWithDispatch(t);
  return tools;
}

export * from "./types";
export { getToolsDir, type ExtensionLoadError } from "./external";
export {
  registerTools,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./registry";

// Wrap built-ins at module load so the agent loop's direct .invoke() calls
// flow through dispatch + timeout (the prior wrap was only inside
// executeTool, which the LangGraph react agent never goes through).
const ALL_BUILTINS: StructuredToolInterface[] = wrapAll(registeredTools());
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = registeredNames();

// Per-call recompute so files dropped in $JARELA_TOOLS_DIR are picked up
// without restart. loadExternalTools cache-busts require() per file.
// Wrap each load — the wrap is idempotent (WRAPPED_MARK guard) so this
// is safe across the cache-bust cycle.
function loadExternal() {
  const result = loadExternalTools(BUILTIN_TOOL_NAMES);
  wrapAll(result.tools);
  return result;
}

export type ToolSource = "builtin" | "external" | "mcp";

// Resolve a tool's origin from its name. Used to label rows in the tools
// API and to route metadata lookups. Returns "mcp" for any name that is
// neither a registered built-in nor an external (JARELA_TOOLS_DIR) tool —
// matches today's behavior where MCP tools are everything else.
export function getToolSource(name: string): ToolSource {
  if (BUILTIN_TOOL_NAMES.has(name)) return "builtin";
  if (loadExternal().tools.some((t) => t.name === name)) return "external";
  return "mcp";
}

// Look up a tool's safety class. Built-in tools have a declared capability;
// external (JARELA_TOOLS_DIR) and MCP tools default to "execute" — the
// conservative choice until manifest-level overrides land (ADR-0038).
// Source is derived internally so callers can't mis-tag external tools as
// MCP (or vice versa).
export function getToolCapability(name: string): Capability {
  return registeredCapability(name) ?? "execute";
}

export function getToolCategory(name: string): ToolCategory {
  const builtin = registeredCategory(name);
  if (builtin) return builtin;
  const ext = loadExternal().categories.get(name);
  if (ext) return ext;
  return getToolSource(name) === "mcp" ? "MCP" : "Config";
}

export function getToolGroup(name: string): ToolGroup {
  const cat = getToolCategory(name);
  if (cat === "MCP") return null;
  return registeredGroup(name) ?? null;
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

// Filter built-in tools whose category is disabled in the toggle store.
// External + MCP tools are untouched (they have their own enable surfaces).
function applyCategoryToggles(tools: StructuredToolInterface[]): StructuredToolInterface[] {
  const disabled = disabledCategories();
  if (disabled.size === 0) return tools;
  return tools.filter((t) => {
    const cat = registeredCategory(t.name);
    if (!cat) return true; // not a built-in (or unregistered) → leave it
    return !disabled.has(cat);
  });
}

// Synchronous: built-in + external tools (no MCP). Used by GET /api/v1/tools
// and any code path that can't await.
export function getAllTools(policy?: ToolPolicy): StructuredToolInterface[] {
  return applyPolicy(
    [...applyCategoryToggles(ALL_BUILTINS), ...loadExternal().tools],
    policy,
  );
}

// Async: built-in + external + MCP tools.
// Use this anywhere the agent might invoke tools (createReactAgent input).
// External tools are loaded per-call (hot-reload). MCP tools are cached by
// lib/mcp/client.ts and only re-resolved when the mcp_servers table changes.
export async function getAllToolsAsync(policy?: ToolPolicy): Promise<StructuredToolInterface[]> {
  let mcpTools: StructuredToolInterface[] = [];
  try {
    // MCP tools are cached by lib/mcp/client.ts; the wrap is idempotent so
    // wrapping each fetch is safe (and necessary for the first fetch after
    // an mcp_servers config change refreshed the cache).
    mcpTools = wrapAll(await getMcpTools());
  } catch (err) {
    console.error("[tools] MCP load failed, continuing with built-ins only:", err);
  }
  return applyPolicy(
    [...applyCategoryToggles(ALL_BUILTINS), ...loadExternal().tools, ...mcpTools],
    policy,
  );
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
  let t = ALL_BUILTINS.find((x) => x.name === name);
  if (t) {
    const cat = registeredCategory(name);
    if (cat && disabledCategories().has(cat)) {
      throw new Error(`Tool "${name}" is disabled (category ${cat} is turned off)`);
    }
  }
  if (!t) {
    t = loadExternal().tools.find((x) => x.name === name);
  }
  if (!t) throw new Error(`Unknown tool: ${name}`);

  const config: RunnableConfig = context.thread_id
    ? { configurable: { thread_id: context.thread_id, signal: context.runSignal } }
    : { configurable: { signal: context.runSignal } };

  // The tool's .invoke is already wrapped at registration time (see
  // wrapToolWithDispatch above) to flow through dispatch + timeout. Calling
  // it here just inherits that coverage — no extra layer needed. The
  // wrap returns the legacy raw shape, which is what historical callers
  // of executeTool expect.
  return t.invoke(args, config);
}

// Bridge ToolResult back to the historical "raw payload" shape so existing
// callers (proposals path, watcher tool, etc.) don't have to migrate in
// the same PR. New callers should consume ToolResult directly via
// `executeToolStructured` below.
function toLegacyShape(result: ToolResult): unknown {
  if (result.kind === "json") return result.data;
  if (result.kind === "text") return result.data;
  // Error case — surface a plain object so existing JSON-shape callers see
  // an `error` field they can detect (matches the prior heuristic in
  // ToolList's isErrorPayload).
  return { error: result.message, code: result.code };
}

/**
 * Like `executeTool` but returns the typed `ToolResult` discriminated union.
 * Prefer this in new call sites — it lets the caller branch on `kind` without
 * heuristic shape-detection.
 */
export async function executeToolStructured(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {},
): Promise<ToolResult> {
  let t = ALL_BUILTINS.find((x) => x.name === name);
  if (t) {
    const cat = registeredCategory(name);
    if (cat && disabledCategories().has(cat)) {
      return { kind: "error", code: "tool_disabled", message: `Tool "${name}" is disabled (category ${cat} is turned off)` };
    }
  }
  if (!t) t = loadExternal().tools.find((x) => x.name === name);
  if (!t) return { kind: "error", code: "unknown_tool", message: `Unknown tool: ${name}` };

  const config: RunnableConfig = context.thread_id
    ? { configurable: { thread_id: context.thread_id, signal: context.runSignal } }
    : { configurable: { signal: context.runSignal } };
  // The wrap returns a legacy raw payload; normalise it back into the
  // ToolResult discriminated union for typed callers. Avoids double-
  // logging by letting the registration wrap own the dispatch entry —
  // we just shape-shift its output here.
  const raw = await t.invoke(args, config);
  return toToolResult(raw);
}

// Inverse of toLegacyShape — turns the legacy raw payload back into a
// ToolResult. Mirrors the heuristic in normalizeToolResult but is keyed
// on the convention `toLegacyShape` produces (`{error, code}` envelope
// for errors). Used only by `executeToolStructured`; the wrap itself
// keeps things in legacy form for the agent loop.
function toToolResult(raw: unknown): ToolResult {
  if (raw && typeof raw === "object" && "error" in raw && "code" in raw) {
    const o = raw as { error: unknown; code: unknown };
    if (typeof o.error === "string" && typeof o.code === "string") {
      return { kind: "error", message: o.error, code: o.code };
    }
  }
  if (typeof raw === "string") return { kind: "text", data: raw };
  return { kind: "json", data: raw };
}

// One-shot startup loader. Call from instrumentation.ts so external tools
// load + log their status at boot rather than lazily on first agent turn.
let _initialized = false;
export interface InitToolsSummary {
  builtinCount: number;
  externalCount: number;
  errors: ExtensionLoadError[];
  toolsDir: string;
}

export function initTools(): InitToolsSummary {
  const toolsDir = getToolsDir();
  const result = loadExternal();
  const summary: InitToolsSummary = {
    builtinCount: ALL_BUILTINS.length,
    externalCount: result.tools.length,
    errors: result.errors,
    toolsDir,
  };

  if (!_initialized) {
    console.info(
      `[tools] ${summary.builtinCount} built-in tool(s) registered; ` +
      `${summary.externalCount} external tool(s) loaded from ${toolsDir}`,
    );
    for (const err of summary.errors) {
      console.error(`[tools] external ${err.file}: ${err.error}`);
    }
    _initialized = true;
  }
  return summary;
}
