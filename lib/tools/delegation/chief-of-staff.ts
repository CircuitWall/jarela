// Chief-of-staff tools: preflight a handoff, review a delegate's evidence, and
// rank open delegations for a cadence decision. These tools are read-only and
// deterministic — execution stays with claude_delegate / codex_delegate /
// copilot_delegate / delegate_to_agent, and every irreversible action still
// needs the user.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { resolveSafetyMode } from "../security/safety";
import { probeGit } from "../support/git-probe";
import { getClaudeCodeConfig } from "./claude-code-config";
import {
  briefId,
  DelegationBriefObject,
  DelegationBriefSchema,
  DelegationObservationSchema,
  DelegationRecordSchema,
  preflightBrief,
  rankDelegationCadence,
  renderDelegationPrompt,
  reviewDelegation,
  type DelegationTarget,
} from "./delegation-contract";

const DELEGATE_TOOL: Record<DelegationTarget, string> = {
  claude: "claude_delegate",
  codex: "codex_delegate",
  copilot: "copilot_delegate",
  agent: "delegate_to_agent",
};

function issues(error: z.ZodError): string {
  return JSON.stringify({
    ok: false,
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

function claudePermissionMode(requested?: string | null): string {
  return requested || getClaudeCodeConfig().launchDefaults.permissionMode || "bypassPermissions";
}

const briefInputSchema = DelegationBriefObject.extend({
  cwd: z.string().trim().min(1).max(2_000).optional()
    .describe("Repository root to preflight (branch and dirty state); omit if unknown."),
}).strict();

export const delegationBriefTool = tool(
  async (input) => {
    const { cwd, ...rawBrief } = input;
    const parsed = DelegationBriefSchema.safeParse(rawBrief);
    if (!parsed.success) return issues(parsed.error);
    const brief = parsed.data;
    const resolvedPermissionMode = brief.target === "claude" ? claudePermissionMode(brief.permission_mode) : null;
    const git = cwd ? await probeGit(cwd) : null;
    const preflight = preflightBrief(brief, {
      safetyMode: resolveSafetyMode(),
      resolvedPermissionMode,
      git,
      cwdProvided: Boolean(cwd),
    });
    const delegateTool = DELEGATE_TOOL[brief.target];
    return JSON.stringify({
      ok: true,
      brief_id: briefId(brief),
      target: brief.target,
      resolved_permission_mode: resolvedPermissionMode,
      proceed: preflight.ready,
      preflight,
      rendered_prompt: renderDelegationPrompt(brief, resolvedPermissionMode),
      next_step: preflight.ready
        ? `Dispatch with ${delegateTool} using rendered_prompt. Record the returned job/session id, then verify with delegation_review.`
        : "Resolve every P0/P1 finding (or revise the brief) before dispatching; do not send a handoff you already know is blocked.",
    });
  },
  {
    name: "delegation_brief",
    description:
      "Preflight a delegation before dispatch. Validates the brief, renders the exact handoff prompt, and reports deterministic blockers: safety mode, a Claude permission mode that auto-denies writes, a default-branch work tree, uncommitted changes, or contradictory scope. Read-only; no model or network calls. " +
      "Use before claude_delegate, codex_delegate, copilot_delegate, or delegate_to_agent. Fix P0/P1 findings or revise the brief instead of retrying a blocked handoff.",
    schema: briefInputSchema,
  },
);

const reviewInputSchema = z.object({
  brief: DelegationBriefObject,
  observation: DelegationObservationSchema,
  max_attempts: z.number().int().min(1).max(10).optional()
    .describe("Retry budget; a failed attempt is escalatable once attempts reach this value. Default 3."),
  previous_findings: z.array(z.string().trim().min(1).max(80)).max(50).optional()
    .describe("Finding codes from earlier attempts for the same task; a recurring code promotes its lesson to the skill."),
}).strict();

export const delegationReviewTool = tool(
  (input) => {
    const parsed = DelegationBriefSchema.safeParse(input.brief);
    if (!parsed.success) return issues(parsed.error);
    return JSON.stringify({
      ok: true,
      brief_id: briefId(parsed.data),
      ...reviewDelegation({
        brief: parsed.data,
        observation: input.observation,
        maxAttempts: input.max_attempts,
        previousFindings: input.previous_findings,
      }),
    });
  },
  {
    name: "delegation_review",
    description:
      "Judge a delegate's result against its brief with recorded evidence. Returns verdict accept | retry | escalate | pending, field-level findings, verified and unverified acceptance ids, changed files, the user decision an escalate requires, and an adaptation plan. " +
      "adaptation.action is none | review | retry | revise_brief | escalate | stop; revise_brief carries a rewritten brief to dispatch instead of the original, and doctrine carries the lesson to apply or persist. " +
      "A delegate's prose summary or a successful spawn is not proof: supply the observed changed files, verification exit codes, permission denials, and actions. Deterministic; no model or network calls. On escalate, stop and surface the decision before any retry.",
    schema: reviewInputSchema,
  },
);

const cadenceInputSchema = z.object({
  records: z.array(DelegationRecordSchema).max(200)
    .describe("Open delegations: id, target, status, timestamps, attempts, verified, and any blocker."),
  now: z.string().trim().max(40).optional().describe("ISO timestamp for a reproducible review; defaults to now."),
  stale_after_minutes: z.number().int().min(1).max(10_080).optional()
    .describe("A running delegation with no update for this long is stalled. Default 30."),
  max_attempts: z.number().int().min(1).max(10).optional().describe("Retry budget used for failed records. Default 3."),
}).strict();

export const delegationCadenceTool = tool(
  (input) => JSON.stringify({
    ok: true,
    ...rankDelegationCadence({
      records: input.records,
      now: input.now,
      staleAfterMinutes: input.stale_after_minutes,
      maxAttempts: input.max_attempts,
    }),
  }),
  {
    name: "delegation_cadence",
    description:
      "Rank open delegations for a chief-of-staff review: blocked, cancelled, failed, stalled, or finished-but-unverified work becomes a P0/P1/P2 decision with an owner and action; clean work yields an explicit no_change record. Read-only; no model or network calls. " +
      "Call on a cadence (or when several delegations are open) so finished-but-unverified and stalled handoffs do not disappear.",
    schema: cadenceInputSchema,
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { read: [delegationBriefTool, delegationReviewTool, delegationCadenceTool] },
});
