import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { registerLangChainPackage } from "../packages/langchain-package";
import { withStreamDefault } from "../support/tool-metadata";
import {
  getAgentConfig,
  parseDelegateTargets,
} from "@/lib/stores/agent-configs";
import { getThread, getOrCreateAgentThread } from "@/lib/stores/threads";
import { releaseSystemSignals } from "@/lib/stores/system-signals";
import {
  MAX_DELEGATION_DEPTH,
  prepareThreadRun,
  persistAssistantMessage,
} from "@/lib/agents/run-thread";
import {
  claimDelegationCall,
  delegationBudgetDeadline,
  delegationBudgetRemainingMs,
  isDelegationBudget,
  type DelegationBudget,
} from "@/lib/agents/delegation-budget";
import { finalizeRouteDecision } from "@/lib/agents/model-router";
import { collectStream } from "@/lib/agents/stream-collector";
import { enqueueThreadRun, QueueExpiredError } from "@/lib/agents/run-queue";
import { resolveTurnProfile } from "@/lib/agents/turn-profile";
import {
  allowedToolNamesFromPermissionMap,
  applyAgentPermissionsToCatalog,
  getAllToolCatalogAsync,
} from "@/lib/tools";
import { errorMessage } from "@/lib/utils/error";

const MAX_TASK_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_EXPECTED_OUTPUT_CHARS = 800;
const MAX_VALIDATION_CHARS = 1_200;
const MAX_RETURNED_OUTPUT_CHARS = 16_000;

interface Handoff {
  task: string;
  context?: string;
  expected_output?: string;
  validation_criteria?: string;
}

interface DelegateContext {
  parentAgentId: string;
  parentThreadId: string;
  depth: number;
  ancestors: readonly string[];
  budget: DelegationBudget;
  signal?: AbortSignal;
}

interface DelegatedRunSuccess {
  collected: Awaited<ReturnType<typeof collectStream>>;
  childId: string;
  childName: string;
  elapsedMs: number;
}

interface DelegatedRunFailure {
  errorCode: string;
  message: string;
  threadId?: string;
  sideEffects?: "none" | "unknown";
}

function readDelegateContext(config?: RunnableConfig): DelegateContext | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  const budget = config?.configurable?.delegation_budget;
  if (!threadId || !isDelegationBudget(budget)) return null;
  const thread = getThread(threadId);
  if (!thread) return null;
  const depthValue = config?.configurable?.delegation_depth;
  const depth = typeof depthValue === "number" && Number.isInteger(depthValue) && depthValue >= 0
    ? depthValue
    : 0;
  const ancestorsRaw = config?.configurable?.delegation_ancestors as
    | readonly string[]
    | undefined;
  const ancestors = Array.isArray(ancestorsRaw)
    ? ancestorsRaw.filter((ancestor): ancestor is string => typeof ancestor === "string")
    : [];
  return {
    parentAgentId: thread.agent_id,
    parentThreadId: threadId,
    depth,
    ancestors,
    budget,
    signal: config?.signal,
  };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: false,
    terminal: "error",
    retryable: false,
    error_code: code,
    message,
    ...extra,
  });
}

function formatHandoff(handoff: Handoff): string {
  return [
    `Task:\n${handoff.task}`,
    `Context:\n${handoff.context || "No additional context was supplied."}`,
    `Expected output:\n${handoff.expected_output || "A concise, self-contained result with relevant evidence and limitations."}`,
    `Validation criteria:\n${handoff.validation_criteria || "Verify the result, distinguish observed facts from assumptions, and state blockers or uncertainty."}`,
  ].join("\n\n");
}

async function validateDelegationTarget(
  agentId: string,
  ctx: DelegateContext,
): Promise<{ parent: NonNullable<ReturnType<typeof getAgentConfig>>; child: NonNullable<ReturnType<typeof getAgentConfig>> } | { error: string }> {
  const parent = getAgentConfig(ctx.parentAgentId);
  if (!parent) return { error: fail("parent_unavailable", "The delegating agent is no longer available.") };
  if (agentId === ctx.parentAgentId || ctx.ancestors.includes(agentId)) {
    return { error: fail("cycle_detected", "Delegation cycle detected; this handoff was not started.") };
  }
  if (ctx.depth >= MAX_DELEGATION_DEPTH) {
    return { error: fail("depth_exceeded", "Maximum delegation depth reached; this handoff was not started.") };
  }

  let permittedTools: Awaited<ReturnType<typeof getAllToolCatalogAsync>>;
  try {
    permittedTools = applyAgentPermissionsToCatalog(await getAllToolCatalogAsync(), parent);
  } catch {
    return { error: fail("permission_unavailable", "Current delegation permission could not be verified.") };
  }
  if (!allowedToolNamesFromPermissionMap(permittedTools).includes("delegate_to_agent")) {
    return { error: fail("permission_denied", "Delegation is no longer permitted for the current agent.") };
  }

  const roster = parseDelegateTargets(parent.delegate_targets);
  if (!roster.includes(agentId)) {
    return { error: fail("not_in_roster", "The requested delegate is not currently authorized.") };
  }
  const child = getAgentConfig(agentId);
  if (!child) return { error: fail("delegate_unavailable", "The requested delegate is no longer available.") };
  return { parent, child };
}

// Runs in the per-thread queue. Authority is re-read only after this callback
// actually starts so roster or permission changes while waiting take effect.
async function runDelegatedTurn(
  childThreadId: string,
  handoff: Handoff,
  agentId: string,
  ctx: DelegateContext,
): Promise<DelegatedRunSuccess | DelegatedRunFailure> {
  const deadlineAt = delegationBudgetDeadline(ctx.budget);
  if (deadlineAt === null) return { errorCode: "no_context", message: "Delegation runtime context is unavailable." };

  try {
    return await enqueueThreadRun<DelegatedRunSuccess | DelegatedRunFailure>(childThreadId, "delegate", async () => {
      if (ctx.signal?.aborted) {
        return { errorCode: "aborted", message: "Delegation was cancelled before execution started.", sideEffects: "none" };
      }
      const currentAuthorization = await validateDelegationTarget(agentId, ctx);
      if ("error" in currentAuthorization) {
        const denied = JSON.parse(currentAuthorization.error) as { error_code: string; message: string };
        return { errorCode: denied.error_code, message: denied.message, sideEffects: "none" };
      }
      const child = currentAuthorization.child;
      const remainingMs = delegationBudgetRemainingMs(ctx.budget);
      if (remainingMs <= 0) {
        return { errorCode: "time_exhausted", message: "The root delegation time budget has expired.", sideEffects: "none" };
      }

      const childAbort = new AbortController();
      let timedOut = false;
      const onParentAbort = () => childAbort.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener("abort", onParentAbort, { once: true });
      if (ctx.signal?.aborted) onParentAbort();
      const timeout = setTimeout(() => {
        timedOut = true;
        childAbort.abort(new Error("Root delegation time budget expired"));
      }, remainingMs);
      const startedAt = Date.now();
      let unconsumedSignalDelivery: Parameters<typeof releaseSystemSignals>[0] | undefined;

      try {
        const prepared = await prepareThreadRun({
          thread_id: childThreadId,
          message: formatHandoff(handoff),
          user_category: "delegation",
          context_profile: resolveTurnProfile("delegate"),
          signal: childAbort.signal,
          _delegation_depth: ctx.depth + 1,
          _delegation_ancestors: [...ctx.ancestors, ctx.parentAgentId],
          _delegation_budget: ctx.budget,
          // A delegated attempt is single-shot: an uncertain provider failure
          // must not silently spend again or route around a failed handoff.
          _transient_retries_left: 0,
          _stall_retries_left: 0,
        });
        unconsumedSignalDelivery = prepared.signal_delivery;
        if (ctx.signal?.aborted || timedOut || delegationBudgetRemainingMs(ctx.budget) <= 0) {
          return {
            errorCode: ctx.signal?.aborted ? "aborted" : "time_exhausted",
            message: ctx.signal?.aborted
              ? "Delegation was cancelled before the child model run started."
              : "The root delegation time budget expired before the child model run started.",
            threadId: childThreadId,
            sideEffects: "none",
          };
        }

        unconsumedSignalDelivery = undefined;
        const collected = await collectStream(prepared.stream);
        if (ctx.signal?.aborted) {
          return {
            errorCode: "aborted",
            message: "Delegation was cancelled; the child run did not complete successfully.",
            threadId: childThreadId,
            sideEffects: "unknown",
          };
        }
        if (timedOut || delegationBudgetRemainingMs(ctx.budget) <= 0) {
          return {
            errorCode: "time_exhausted",
            message: "The root delegation time budget expired before the child completed.",
            threadId: childThreadId,
            sideEffects: "unknown",
          };
        }
        if (collected.aborted) {
          return {
            errorCode: "aborted",
            message: "The delegated child run was aborted and did not complete successfully.",
            threadId: childThreadId,
            sideEffects: "unknown",
          };
        }
        if (collected.terminal !== "done") {
          return {
            errorCode: collected.errorCode === "delegation_cost_budget"
              || /delegation (?:inference|cost budget)|canonical pricing/i.test(collected.errorMessage ?? "")
              ? "cost_exhausted"
              : "child_error",
            message: collected.errorMessage ?? "The delegated run ended without a successful terminal result.",
            threadId: childThreadId,
            sideEffects: "unknown",
          };
        }
        const result = collected.assistantContent.trim();
        if (!result || result.length > MAX_RETURNED_OUTPUT_CHARS) {
          return {
            errorCode: "invalid_output",
            message: result
              ? `The delegated result exceeded the ${MAX_RETURNED_OUTPUT_CHARS}-character output limit.`
              : "The delegated run completed without a non-empty result.",
            threadId: childThreadId,
            sideEffects: "unknown",
          };
        }
        const routeDecision = finalizeRouteDecision(
          collected.routeDecision ?? prepared.route_decision ?? null,
          {
            durationMs: Date.now() - startedAt,
            terminal: collected.terminal,
            errorCode: collected.errorCode,
            retryCount: collected.routeDecision?.retry_count ?? prepared.route_decision?.retry_count ?? 0,
          },
        );
        persistAssistantMessage(
          childThreadId,
          result,
          collected.usedTools,
          collected.toolEvents,
          "delegation",
          collected.usage ?? null,
          prepared.context_snapshot ?? null,
          prepared.source_manifest ?? null,
          routeDecision,
          prepared.memory_recall ? { memory_recall: prepared.memory_recall } : null,
          prepared.signal_delivery,
        );
        return {
          collected: { ...collected, assistantContent: result },
          childId: child.id,
          childName: child.name,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          errorCode: timedOut || delegationBudgetRemainingMs(ctx.budget) <= 0 ? "time_exhausted" : "child_error",
          message: errorMessage(error),
          threadId: childThreadId,
          sideEffects: "unknown",
        };
      } finally {
        if (unconsumedSignalDelivery) releaseSystemSignals(unconsumedSignalDelivery);
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onParentAbort);
      }
    }, { expiresAt: deadlineAt }).result;
  } catch (error) {
    return {
      errorCode: error instanceof QueueExpiredError ? "time_exhausted" : "child_error",
      message: error instanceof QueueExpiredError
        ? "The root delegation time budget expired while the handoff was queued."
        : errorMessage(error),
      threadId: childThreadId,
      sideEffects: "none",
    };
  }
}

const HandoffSchema = z.object({
  agent_id: z.string().trim().min(1).max(200).describe(
    "The id of a delegate in the authorized 'Available delegates' list.",
  ),
  task: z.string().trim().min(1).max(MAX_TASK_CHARS).describe(
    "A concrete, self-contained task. Include the action and desired outcome; the delegate cannot see the caller's conversation.",
  ),
  context: z.string().trim().min(1).max(MAX_CONTEXT_CHARS).optional().describe(
    "Only the task-relevant context the delegate needs; omit unrelated or sensitive conversation details.",
  ),
  expected_output: z.string().trim().min(1).max(MAX_EXPECTED_OUTPUT_CHARS).optional().describe(
    "The bounded shape of the result to return. Omission uses a safe concise-result default.",
  ),
  validation_criteria: z.string().trim().min(1).max(MAX_VALIDATION_CHARS).optional().describe(
    "Concrete checks the delegate should report. Omission uses a safe verify-and-disclose-uncertainty default.",
  ),
});

export const delegateToAgentTool = withStreamDefault(tool(
  async ({ agent_id, task, context, expected_output, validation_criteria }, config) => {
    const ctx = readDelegateContext(config);
    if (!ctx) return fail("no_context", "Delegation runtime context is missing or invalid.");

    const handoff: Handoff = { task, context, expected_output, validation_criteria };
    const validated = await validateDelegationTarget(agent_id, ctx);
    if ("error" in validated) return validated.error;
    if (ctx.signal?.aborted) return fail("aborted", "Delegation was cancelled before it was queued.");

    const claimed = claimDelegationCall(ctx.budget);
    if (!claimed.ok) {
      return fail(
        claimed.reason,
        claimed.reason === "calls_exhausted"
          ? "The root delegation call budget is exhausted."
          : "The root delegation time budget has expired.",
      );
    }

    const childThread = getOrCreateAgentThread(agent_id);
    const run = await runDelegatedTurn(childThread.thread_id, handoff, agent_id, ctx);
    if ("errorCode" in run) {
      return fail(run.errorCode, run.message, {
        ...(run.threadId ? { thread_id: run.threadId } : {}),
        ...(run.sideEffects ? { side_effects: run.sideEffects } : {}),
      });
    }

    const { collected } = run;
    return JSON.stringify({
      ok: true,
      terminal: "done",
      agent_id: run.childId,
      agent_name: run.childName,
      thread_id: childThread.thread_id,
      depth: ctx.depth + 1,
      result: collected.assistantContent,
      used_tools: Array.from(new Set(collected.usedTools)),
      elapsed_ms: run.elapsedMs,
      provenance: {
        delegated_by_agent_id: ctx.parentAgentId,
        parent_thread_id: ctx.parentThreadId,
        child_agent_id: run.childId,
        child_thread_id: childThread.thread_id,
        terminal: "done",
        call_number: claimed.callNumber,
      },
      parent_accountability: "The parent agent remains responsible for validating this handoff result and completing the user's task.",
      cite_as: `[${run.childName}'s reply](?thread=${childThread.thread_id}&agent=${run.childId})`,
    });
  },
  {
    name: "delegate_to_agent",
    description:
      "Hand a bounded, concrete subtask to an authorized specialist. The delegate sees only the task and supplied context, not this conversation. " +
      "Provide the expected output and validation criteria when they are task-specific; task-only handoffs remain supported with safe defaults. " +
      "The call rechecks current roster and permission when queued execution starts, shares the root call/time/cost budget, and never retries or reroutes an uncertain handoff. " +
      "Only delegate when the target is genuinely better-suited. Before calling, tell the user in one sentence which agent you are handing to and why. " +
      "The parent remains accountable for checking the result.",
    schema: HandoffSchema,
  },
), true);

registerLangChainPackage({
  category: "Agent",
  tools: { execute: [delegateToAgentTool] },
});
