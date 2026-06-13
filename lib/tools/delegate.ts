import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { registerLangChainPackage } from "./langchain-package";
import {
  getAgentConfig,
  parseDelegateTargets,
} from "@/lib/stores/agent-configs";
import { getThread, getOrCreateAgentThread } from "@/lib/stores/threads";
import {
  MAX_DELEGATION_DEPTH,
  prepareThreadRun,
  persistAssistantMessage,
} from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import { enqueueThreadRun } from "@/lib/agents/run-queue";
import { resolveTurnProfile } from "@/lib/agents/turn-profile";

interface DelegateContext {
  parentAgentId: string;
  depth: number;
  ancestors: readonly string[];
}

function readDelegateContext(config?: RunnableConfig): DelegateContext | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  const thread = getThread(threadId);
  if (!thread) return null;
  const depth = (config?.configurable?.delegation_depth as number | undefined) ?? 0;
  const ancestorsRaw = config?.configurable?.delegation_ancestors as
    | readonly string[]
    | undefined;
  const ancestors = Array.isArray(ancestorsRaw) ? ancestorsRaw : [];
  return { parentAgentId: thread.agent_id, depth, ancestors };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error_code: code, message, ...extra });
}

// Validates that delegation is allowed: target isn't self, isn't an ancestor
// (cycle), depth is within budget, and target is in the parent's roster.
// Returns the resolved child config on success, or an error JSON to forward.
function validateDelegationTarget(
  agentId: string,
  ctx: DelegateContext,
): { child: NonNullable<ReturnType<typeof getAgentConfig>> } | { error: string } {
  const parent = getAgentConfig(ctx.parentAgentId);
  if (!parent) return { error: fail("agent_not_found", `Parent agent "${ctx.parentAgentId}" not found`) };
  if (agentId === ctx.parentAgentId) return { error: fail("cycle_detected", "Cannot delegate to self") };
  if (ctx.ancestors.includes(agentId)) {
    return { error: fail("cycle_detected", `Delegation cycle: ${agentId} is already in the chain [${ctx.ancestors.join(" -> ")}]`) };
  }
  if (ctx.depth >= MAX_DELEGATION_DEPTH) {
    return { error: fail(
      "depth_exceeded",
      `Maximum delegation depth (${MAX_DELEGATION_DEPTH}) reached. Chain: [${[...ctx.ancestors, ctx.parentAgentId].join(" -> ")}]`,
    ) };
  }
  const roster = parseDelegateTargets(parent.delegate_targets);
  if (!roster.includes(agentId)) {
    return { error: fail(
      "not_in_roster",
      `Agent "${agentId}" is not in the delegate roster for "${parent.id}". Available: [${roster.join(", ") || "none"}]`,
    ) };
  }
  const child = getAgentConfig(agentId);
  if (!child) return { error: fail("agent_not_found", `Delegate agent "${agentId}" not found`) };
  return { child };
}

// Runs the child agent's turn inside the run-queue so it serialises with
// every other entry point (HTTP POST, scheduler, watcher, bridge, sibling
// delegations) on the child thread — see lib/agents/run-queue.ts. A delegate
// fired while the child is already running waits in the child's queue
// instead of racing the checkpoint store.
async function runDelegatedTurn(
  childThreadId: string,
  task: string,
  ctx: DelegateContext,
): Promise<Awaited<ReturnType<typeof collectStream>>> {
  return enqueueThreadRun(childThreadId, "delegate", async () => {
    const prepared = await prepareThreadRun({
      thread_id: childThreadId,
      message: task,
      user_category: "delegation",
      context_profile: resolveTurnProfile("delegate"),
      _delegation_depth: ctx.depth + 1,
      _delegation_ancestors: [...ctx.ancestors, ctx.parentAgentId],
    });
    const collected = await collectStream(prepared.stream);
    if (collected.terminal !== "error") {
      persistAssistantMessage(
        childThreadId,
        collected.assistantContent,
        collected.usedTools,
        collected.toolEvents,
        "delegation",
        collected.usage ?? null,
        prepared.context_snapshot ?? null,
        prepared.source_manifest ?? null,
      );
    }
    return collected;
  }).result;
}

export const delegateToAgentTool = tool(
  async ({ agent_id, task }, config) => {
    const ctx = readDelegateContext(config);
    if (!ctx) return fail("no_context", "No agent context (missing thread_id)");

    const validated = validateDelegationTarget(agent_id, ctx);
    if ("error" in validated) return validated.error;
    const { child } = validated;

    const childThread = getOrCreateAgentThread(agent_id);
    const startedAt = Date.now();

    try {
      const queued = await runDelegatedTurn(childThread.thread_id, task, ctx);
      const elapsed_ms = Date.now() - startedAt;

      if (queued.terminal === "error") {
        return fail("child_error", queued.errorMessage ?? "Child agent run failed", {
          agent_id,
          agent_name: child.name,
          thread_id: childThread.thread_id,
        });
      }

      return JSON.stringify({
        ok: true,
        agent_id: child.id,
        agent_name: child.name,
        thread_id: childThread.thread_id,
        depth: ctx.depth + 1,
        result: queued.assistantContent.trim(),
        used_tools: Array.from(new Set(queued.usedTools)),
        elapsed_ms,
        // Ready-to-paste markdown link the parent agent can drop into its
        // reply so the user can trace the summary back to the delegate's
        // full thread. The chat UI resolves `?thread=<tid>&agent=<aid>`
        // via parseHref → SELECT_THREAD, which atomically sets both
        // activeThreadId and activeAgentId (chat tab won't render the
        // thread without the agent id).
        cite_as: `[${child.name}'s reply](?thread=${childThread.thread_id}&agent=${child.id})`,
      });
    } catch (err) {
      return fail("child_error", err instanceof Error ? err.message : String(err), {
        agent_id,
        agent_name: child.name,
        thread_id: childThread.thread_id,
      });
    }
  },
  {
    name: "delegate_to_agent",
    description:
      "Hand a subtask to another agent that has specialized knowledge or tools you lack. " +
      "The delegate runs in its own thread; the user sees a tool card with the delegate's name, " +
      "the task you sent, and the delegate's final answer (plus a link to open the delegate's thread). " +
      "Only delegate when the target agent is genuinely better-suited — do NOT delegate trivial subtasks " +
      "you can handle yourself. Before calling this tool, tell the user in one sentence which agent you " +
      "are handing to and why. Available delegate ids are listed in the 'Available delegates' system " +
      "section; calling with an id outside that list will be refused.",
    schema: z.object({
      agent_id: z.string().describe(
        "The id of the delegate agent. Must appear in the 'Available delegates' list in your system prompt.",
      ),
      task: z.string().min(1).describe(
        "A self-contained task description for the delegate. Include all context the delegate needs — " +
        "the delegate does NOT see your conversation history with the user, only this task string.",
      ),
    }),
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { execute: [delegateToAgentTool] },
});
