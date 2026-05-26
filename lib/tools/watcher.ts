// Watcher tools (ADR-0027). Agent-facing CRUD for event-driven tasks.
// Mirrors lib/tools/schedule.ts in shape so agents have a familiar
// surface area: schedule_task ↔ schedule_watcher, list_scheduled_tasks
// ↔ list_watchers, cancel_scheduled_task ↔ cancel_watcher.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { registerTools, registeredTools } from "./registry";
import {
  createWatcher,
  listWatchers,
  deleteWatcher,
} from "@/lib/stores/watchers";
import { getThread } from "@/lib/stores/threads";
import { startScheduler } from "@/lib/scheduler";

function agentIdFromConfig(config?: RunnableConfig): string | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  const thread = getThread(threadId);
  return thread?.agent_id ?? null;
}

export const scheduleWatcherTool = tool(
  async ({ label, tool: toolName, args, every_seconds, silent }, config) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "No agent context (missing thread_id)" });
    // Sanity-check that the tool exists locally. We can only register
    // watchers over built-in tools — MCP / external tool surfaces aren't
    // poll-safe in the scheduler (no per-request side context).
    const target = registeredTools().find((t) => t.name === toolName);
    if (!target) {
      return JSON.stringify({
        error: `Tool "${toolName}" is not a built-in tool. Watchers can only poll built-in tools.`,
      });
    }
    try {
      const row = createWatcher({
        agent_id: agentId,
        label,
        tool_name: toolName,
        tool_args: args ?? {},
        interval_seconds: every_seconds,
        silent,
      });
      startScheduler();
      return JSON.stringify({
        ok: true,
        id: row.id,
        next_run_at: row.next_run_at,
        interval_seconds: row.interval_seconds,
        silent: row.silent === 1,
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  {
    name: "schedule_watcher",
    description:
      "Register an event-driven watcher: poll one built-in tool every N seconds " +
      "and re-engage this agent only when the tool's output changes since the " +
      "previous poll. Unlike schedule_task, this consumes zero LLM tokens between " +
      "changes — the scheduler runs the tool, hashes the result (SHA-256 of the " +
      "stringified return value), and only fires the agent on a diff. The agent " +
      "receives the previous + current results as context.\n\n" +
      "WHEN TO USE (use this instead of schedule_task whenever the user wants " +
      "to be notified about CHANGES rather than at fixed times):\n" +
      "  • 'tell me when Jira issue ABC-123 changes status' → jira_get_issue\n" +
      "  • 'ping me when a new ticket lands in SLPV assigned to me' → jira_search with a narrow JQL\n" +
      "  • 'notify me when files appear in ~/Downloads' → file_list on that path\n" +
      "  • 'watch this Confluence page for edits' → confluence_get_page\n" +
      "  • 'tell me when a webpage changes' → web_fetch\n\n" +
      "This is the SUBSTITUTE for webhooks and OS-level filesystem events, which " +
      "Jarela does not have. Don't tell the user 'no webhook support' — propose a " +
      "watcher instead.\n\n" +
      "LIMITS (be honest with the user about these):\n" +
      "  • Built-in tools only (no MCP / external tools — scheduler runs without per-request context).\n" +
      "  • Minimum interval 60 seconds.\n" +
      "  • Diff is byte-exact SHA-256 of the tool's stringified result. If the tool " +
      "returns volatile fields (e.g. `updated` timestamps, view counts) the watcher " +
      "will fire on every poll. Mitigate by passing args that narrow the tool's " +
      "output (e.g. `fields` on jira_search, specific paths on file_list).\n" +
      "  • First poll seeds the baseline silently — the agent is NOT fired on creation.\n\n" +
      "Set silent=true to let the agent reply with NO_REPLY on changes it judges immaterial.",
    schema: z.object({
      label: z.string().min(1).describe("Short human-readable name (e.g. 'ABC-123 status')"),
      tool: z.string().min(1).describe("Name of a built-in tool to poll (e.g. 'jira_get_issue')"),
      args: z.record(z.string(), z.unknown()).optional().describe(
        "Arguments to pass to the tool on every poll, as a JSON object",
      ),
      every_seconds: z.number().int().min(60).describe(
        "Polling interval in seconds. Minimum 60.",
      ),
      silent: z.boolean().optional().describe(
        "When true the agent is instructed to reply only when the change is material; " +
        "NO_REPLY firings are dropped. Visible firings remain tagged 'watcher'.",
      ),
    }),
  },
);

export const listWatchersTool = tool(
  async (_args, config) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "No agent context" });
    const watchers = listWatchers(agentId).map((w) => ({
      id: w.id,
      label: w.label,
      tool: w.tool_name,
      args: safeParse(w.tool_args),
      interval_seconds: w.interval_seconds,
      next_run_at: w.next_run_at,
      last_run_at: w.last_run_at,
      last_fired_at: w.last_fired_at,
      last_error: w.last_error,
      enabled: w.enabled === 1,
      silent: w.silent === 1,
    }));
    return JSON.stringify({ watchers, count: watchers.length });
  },
  {
    name: "list_watchers",
    description: "List all event-driven watchers registered for the current agent.",
    schema: z.object({}),
  },
);

export const cancelWatcherTool = tool(
  async ({ id }) => {
    const ok = deleteWatcher(id);
    return JSON.stringify(ok ? { ok: true, id } : { error: `Watcher ${id} not found` });
  },
  {
    name: "cancel_watcher",
    description: "Cancel a previously registered watcher by id.",
    schema: z.object({
      id: z.string().describe("Watcher id returned by schedule_watcher or list_watchers"),
    }),
  },
);

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

registerTools("Schedule", [scheduleWatcherTool, listWatchersTool, cancelWatcherTool]);
