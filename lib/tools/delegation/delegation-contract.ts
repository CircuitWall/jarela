// Deterministic contract for the chief-of-staff pattern.
//
// The coordinator (the calling agent) owns the goal and the final answer. It
// delegates execution to a specialist (an internal agent or a local Claude /
// Codex / Copilot CLI) with a complete brief, then verifies observed evidence
// before accepting the result. This module is the code-first half of that
// loop: preflight the handoff, judge the returned evidence, and rank open
// delegations for a cadence review. No model calls, no network, no writes.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { SafetyMode } from "../security/safety";
import type { GitProbe } from "../support/git-probe";

export const DELEGATION_TARGETS = ["claude", "codex", "copilot", "agent"] as const;
export type DelegationTarget = (typeof DELEGATION_TARGETS)[number];

export type DelegationSeverity = "P0" | "P1" | "P2";

export interface DelegationFinding {
  code: string;
  severity: DelegationSeverity;
  detail: string;
  action: string;
}

const acceptanceIdSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i);

const acceptanceFields = {
  id: acceptanceIdSchema.describe("Stable id the delegate must echo in its verification evidence."),
  description: z.string().trim().min(1).max(300),
  kind: z.enum(["command", "manual"]).describe("command: run the exact command and report its exit code; manual: record an observed inspection."),
  command: z.string().trim().min(1).max(500).optional().describe("Required when kind=command; the exact command the delegate must run."),
};

export const DelegationAcceptanceObject = z.object(acceptanceFields).strict();

export const DelegationAcceptanceSchema = DelegationAcceptanceObject.superRefine((value, ctx) => {
  if (value.kind === "command" && !value.command) {
    ctx.addIssue({ code: "custom", path: ["command"], message: "kind=command requires the exact command to run" });
  }
  if (value.kind === "manual" && value.command) {
    ctx.addIssue({ code: "custom", path: ["command"], message: "kind=manual must not carry a command" });
  }
});

const briefFields = {
  objective: z.string().trim().min(1).max(4_000),
  context: z.string().trim().max(8_000).optional(),
  expected_output: z.string().trim().min(1).max(1_200),
  acceptance: z.array(DelegationAcceptanceSchema).min(1).max(12),
  scope_paths: z.array(z.string().trim().min(1).max(300)).max(40).optional()
    .describe("Repository-relative path prefixes the delegate may change."),
  forbidden: z.array(z.string().trim().min(1).max(300)).max(40).optional()
    .describe("Paths or actions the delegate must not touch, e.g. 'docs/adr/' or 'git push'."),
  target: z.enum(DELEGATION_TARGETS),
  permission_mode: z.string().trim().min(1).max(40).optional()
    .describe("Claude Code permission mode; ignored for other targets. Defaults to the configured mode."),
  read_only: z.boolean().optional(),
  background: z.boolean().optional(),
};

function uniqueAcceptanceIds<T extends { acceptance: Array<{ id: string }> }>(
  brief: T,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const item of brief.acceptance) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", path: ["acceptance"], message: `duplicate acceptance id: ${item.id}` });
    }
    seen.add(item.id);
  }
}

export const DelegationBriefObject = z.object(briefFields).strict();
export const DelegationBriefSchema = DelegationBriefObject.superRefine(uniqueAcceptanceIds);
export type DelegationBrief = z.infer<typeof DelegationBriefObject>;

export function briefId(brief: DelegationBrief): string {
  const normalized = {
    ...brief,
    objective: brief.objective.trim(),
    expected_output: brief.expected_output.trim(),
    acceptance: [...brief.acceptance].sort((left, right) => left.id.localeCompare(right.id)),
    scope_paths: brief.scope_paths ? [...brief.scope_paths].sort() : undefined,
    forbidden: brief.forbidden ? [...brief.forbidden].sort() : undefined,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function isUnder(file: string, prefix: string): boolean {
  const normalizedPrefix = normalizePath(prefix);
  return file === normalizedPrefix || file.startsWith(normalizedPrefix.endsWith("/") ? normalizedPrefix : `${normalizedPrefix}/`);
}

const WRITE_DENYING_MODES = new Set(["default", "dontAsk", "plan"]);
const PARTIAL_SHELL_MODES = new Set(["acceptEdits", "auto"]);
const DEFAULT_BRANCHES = new Set(["main", "master"]);

export interface DelegationPreflightContext {
  safetyMode: SafetyMode;
  /** Effective Claude permission mode, when the target is Claude. */
  resolvedPermissionMode?: string | null;
  git?: Pick<GitProbe, "is_repo" | "branch" | "dirty"> | null;
  cwdProvided?: boolean;
}

function targetFindings(brief: DelegationBrief, context: DelegationPreflightContext): DelegationFinding[] {
  const findings: DelegationFinding[] = [];
  if (context.safetyMode === "safe") {
    findings.push({
      code: "delegation_blocked",
      severity: "P0",
      detail: "JARELA_TOOL_SAFETY=safe refuses every delegate tool before a spawn.",
      action: "Raise the safety mode for this deployment, or handle the task without delegation.",
    });
  }
  if (brief.target === "claude" && !brief.read_only) {
    const mode = context.resolvedPermissionMode ?? "bypassPermissions";
    if (WRITE_DENYING_MODES.has(mode)) {
      findings.push({
        code: "permission_mode_denies_writes",
        severity: "P1",
        detail: `Claude headless mode '${mode}' auto-denies write/exec tool calls, so the delegate cannot satisfy a non-read-only brief.`,
        action: "Use permission_mode 'bypassPermissions' (or 'acceptEdits' for edits without shell), or make the brief read-only.",
      });
    } else if (PARTIAL_SHELL_MODES.has(mode)) {
      findings.push({
        code: "permission_mode_may_deny_shell",
        severity: "P2",
        detail: `Claude mode '${mode}' may still deny shell commands that the acceptance criteria require.`,
        action: "Use 'bypassPermissions' when acceptance runs commands such as git or npm test.",
      });
    }
  }
  if (brief.target === "codex" && brief.read_only) {
    findings.push({
      code: "read_only_not_enforced",
      severity: "P2",
      detail: "codex exec runs with --sandbox workspace-write; read_only can only be stated in the prompt, not enforced.",
      action: "State the read-only constraint in the prompt and verify that no files changed.",
    });
  }
  return findings;
}

function workspaceFindings(brief: DelegationBrief, context: DelegationPreflightContext): DelegationFinding[] {
  const findings: DelegationFinding[] = [];
  if (!context.cwdProvided) {
    findings.push({
      code: "cwd_missing",
      severity: "P2",
      detail: "No cwd was supplied, so git state and branch policy were not checked.",
      action: "Call workspace_init (or pass cwd) before dispatching so the handoff targets the intended repository.",
    });
    return findings;
  }
  const git = context.git;
  if (!git || !git.is_repo) {
    findings.push({
      code: "git_not_repo",
      severity: "P2",
      detail: "The supplied cwd is not a git work tree; change verification and branch policy are unavailable.",
      action: "Confirm the directory is the intended project; otherwise pass the repository root.",
    });
    return findings;
  }
  if (!brief.read_only && git.branch && DEFAULT_BRANCHES.has(git.branch)) {
    findings.push({
      code: "on_default_branch",
      severity: "P1",
      detail: `The work tree is on '${git.branch}'. A delegate that commits would write to the default branch.`,
      action: "Create a topic branch first, or make the handoff explicitly read-only.",
    });
  }
  if (git.dirty) {
    findings.push({
      code: "dirty_worktree",
      severity: "P2",
      detail: "The work tree already has uncommitted changes, so the delegate's diff will mix prior work with its own.",
      action: "Commit or stash unrelated changes, or review the combined diff against the expected scope.",
    });
  }
  return findings;
}

function scopeContradictions(brief: DelegationBrief): DelegationFinding[] {
  if (!brief.scope_paths || !brief.forbidden) return [];
  const forbidden = new Set(brief.forbidden.map(normalizePath));
  return brief.scope_paths
    .map(normalizePath)
    .filter((scope) => forbidden.has(scope))
    .map((scope) => ({
      code: "scope_contradiction",
      severity: "P1",
      detail: `'${scope}' is both an allowed scope and a forbidden path.`,
      action: "Resolve the overlap before dispatch; the delegate cannot satisfy both instructions.",
    }));
}

export interface DelegationPreflight {
  ready: boolean;
  findings: DelegationFinding[];
}

export function preflightBrief(
  brief: DelegationBrief,
  context: DelegationPreflightContext,
): DelegationPreflight {
  const findings = [
    ...targetFindings(brief, context),
    ...workspaceFindings(brief, context),
    ...scopeContradictions(brief),
  ];
  return { ready: findings.every((finding) => finding.severity === "P2"), findings };
}

export function renderDelegationPrompt(brief: DelegationBrief, resolvedPermissionMode?: string | null): string {
  const scope = brief.scope_paths?.length
    ? brief.scope_paths.map((item) => `- Allowed: ${item}`).join("\n")
    : "- No explicit path scope was declared; change only what the objective requires.";
  const forbidden = brief.forbidden?.length
    ? brief.forbidden.map((item) => `- Forbidden: ${item}`).join("\n")
    : "- Do not push, merge, publish, release, or delete anything unless the objective explicitly asks and the user approved it.";
  const acceptance = brief.acceptance
    .map((item) => item.kind === "command"
      ? `${item.id}. ${item.description} — run exactly: \`${item.command}\`; record the exit code.`
      : `${item.id}. ${item.description} — record the observed inspection result.`)
    .join("\n");
  const permission = resolvedPermissionMode
    ? `\nRuntime permission mode: ${resolvedPermissionMode}.`
    : "";
  return [
    "You are a delegate executing a bounded task. Follow this brief exactly and return the reporting object at the end.",
    "",
    "## Objective",
    brief.objective,
    "",
    "## Context",
    brief.context || "No additional context was supplied.",
    "",
    "## Scope",
    scope,
    forbidden,
    "",
    "## Expected output",
    brief.expected_output,
    "",
    "## Acceptance criteria",
    acceptance,
    "",
    "## Reporting contract",
    "Return one JSON object with this shape (no prose outside it):",
    '{"status":"done|blocked|error","summary":"...","changed_files":["path"],"verification":[{"acceptance_id":"id","command":"...","exit_code":0,"output":"..."}],"permission_denials":["exact denied command"],"actions":["git switch -c feature"]}',
    "Use status=blocked when a permission or approval gate stops you.",
    "",
    "## Operating rules",
    "- Work only inside the allowed scope and acceptance criteria.",
    "- If a tool call is denied for permission, STOP retrying. Record the exact command in permission_denials and return status=blocked.",
    "- Do not claim a command ran or passed without recording its actual exit code and output.",
    "- Do not push, merge, publish, release, or rewrite published history unless the objective explicitly asks and the user approved it.",
    "- Leave the workspace inspectable: no cleanup that hides what changed.",
    permission,
  ].join("\n");
}

// ── Review ────────────────────────────────────────────────────────────────

export const DelegationVerificationSchema = z.object({
  acceptance_id: z.string().trim().min(1).max(80),
  command: z.string().trim().max(500).optional(),
  exit_code: z.number().int().nullable().optional(),
  output: z.string().max(8_000).optional(),
  observation: z.string().max(4_000).optional(),
}).strict();

export const DelegationObservationSchema = z.object({
  status: z.enum(["running", "done", "error", "blocked", "cancelled"]),
  attempts: z.number().int().min(0).max(20).optional(),
  summary: z.string().max(16_000).optional(),
  error: z.string().max(4_000).optional(),
  changed_files: z.array(z.string().trim().min(1).max(500)).max(500).optional(),
  verification: z.array(DelegationVerificationSchema).max(40).optional(),
  permission_denials: z.array(z.string().trim().min(1).max(1_000)).max(50).optional(),
  actions: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
}).strict();

export type DelegationObservation = z.infer<typeof DelegationObservationSchema>;
export type DelegationVerification = z.infer<typeof DelegationVerificationSchema>;

export interface DelegationReviewInput {
  brief: DelegationBrief;
  observation: DelegationObservation;
  maxAttempts?: number;
  /** Finding codes observed in earlier attempts for the same task. */
  previousFindings?: string[];
}

export type DelegationAdaptationAction =
  | "none" | "review" | "retry" | "revise_brief" | "escalate" | "stop";

export interface DelegationDoctrine {
  code: string;
  lesson: string;
  recurring: boolean;
  /** task: apply to this handoff; skill: persist into the coordinator's procedure. */
  persist: "skill" | "task";
}

export interface DelegationAdaptation {
  action: DelegationAdaptationAction;
  /** Present when action=revise_brief; re-dispatch this, not the original. */
  revised_brief: DelegationBrief | null;
  changes: Array<{ field: string; reason: string }>;
  requires_user: boolean;
  doctrine: DelegationDoctrine | null;
  next_actions: string[];
}

export interface DelegationReview {
  verdict: "accept" | "retry" | "escalate" | "pending";
  findings: DelegationFinding[];
  verified_acceptance: string[];
  unverified_acceptance: string[];
  changed_files: string[];
  next_actions: string[];
  user_decision: string | null;
  adaptation: DelegationAdaptation;
}

const ESCALATE_CODES = new Set([
  "permission_denied", "delegate_blocked", "delegate_cancelled", "retry_exhausted",
  "out_of_scope_change", "forbidden_action", "unapproved_irreversible_action",
  "read_only_violation", "invalid_observation",
]);

const RETRY_CODES = new Set(["missing_validation_evidence", "failed_acceptance", "transient_failure"]);

interface AcceptanceAssessment {
  verified: string[];
  unverified: string[];
  findings: DelegationFinding[];
}

function assessAcceptance(
  brief: DelegationBrief,
  verification: DelegationVerification[],
): AcceptanceAssessment {
  const verified: string[] = [];
  const unverified: string[] = [];
  const findings: DelegationFinding[] = [];
  for (const criterion of brief.acceptance) {
    const evidence = verification.find((item) => item.acceptance_id === criterion.id);
    if (!evidence) {
      unverified.push(criterion.id);
      findings.push({
        code: "missing_validation_evidence",
        severity: "P1",
        detail: `Acceptance '${criterion.id}' has no recorded evidence.`,
        action: "Send the exact missing criterion back to the delegate and retry within the attempt budget.",
      });
      continue;
    }
    if (criterion.kind === "manual") {
      if (evidence.observation?.trim()) {
        verified.push(criterion.id);
      } else {
        unverified.push(criterion.id);
        findings.push({
          code: "missing_validation_evidence",
          severity: "P1",
          detail: `Acceptance '${criterion.id}' has no recorded observation.`,
          action: "Send the exact missing criterion back to the delegate and retry within the attempt budget.",
        });
      }
      continue;
    }
    if (!evidence.command || normalizePath(evidence.command) !== normalizePath(criterion.command ?? "")) {
      unverified.push(criterion.id);
      findings.push({
        code: "missing_validation_evidence",
        severity: "P1",
        detail: `Acceptance '${criterion.id}' did not run the exact required command.`,
        action: `Re-run exactly: ${criterion.command}`,
      });
      continue;
    }
    if (evidence.exit_code === 0) {
      verified.push(criterion.id);
    } else if (evidence.exit_code !== 0 && evidence.exit_code != null) {
      unverified.push(criterion.id);
      findings.push({
        code: "failed_acceptance",
        severity: "P1",
        detail: `Acceptance '${criterion.id}' exited ${evidence.exit_code}. ${(evidence.output ?? "").slice(0, 300)}`.trim(),
        action: "Return the failing output to the delegate with the acceptance criterion.",
      });
    } else {
      unverified.push(criterion.id);
      findings.push({
        code: "missing_validation_evidence",
        severity: "P1",
        detail: `Acceptance '${criterion.id}' reported no observed exit code.`,
        action: `Re-run exactly: ${criterion.command}`,
      });
    }
  }
  return { verified, unverified, findings };
}

function scopeFindings(brief: DelegationBrief, files: string[]): DelegationFinding[] {
  const findings: DelegationFinding[] = [];
  if (brief.scope_paths?.length) {
    const violations = files.filter((file) => !brief.scope_paths!.some((prefix) => isUnder(file, prefix)));
    if (violations.length > 0) {
      findings.push({
        code: "out_of_scope_change",
        severity: "P1",
        detail: `Changed outside the declared scope: ${violations.slice(0, 8).join(", ")}${violations.length > 8 ? " …" : ""}.`,
        action: "Decide whether to accept the expanded scope or revert the extra paths before accepting the result.",
      });
    }
  }
  if (brief.read_only && files.length > 0) {
    findings.push({
      code: "read_only_violation",
      severity: "P1",
      detail: `The brief was read-only but ${files.length} path(s) changed.`,
      action: "Review and revert the changes, or explicitly revise the brief to allow them.",
    });
  }
  return findings;
}

const IRREVERSIBLE_ACTIONS: Array<{ keyword: string; pattern: RegExp }> = [
  { keyword: "push", pattern: /\bgit\s+push\b|--force(?:-with-lease)?\b|force-push/i },
  { keyword: "merge", pattern: /\bgit\s+merge\b|\bgh\s+pr\s+merge\b/i },
  { keyword: "publish", pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/i },
  { keyword: "release", pattern: /\bgh\s+release\b|\brelease\s+create\b/i },
  { keyword: "delete", pattern: /\bgit\s+push\b[^\n]*--delete\b|\bgh\s+repo\s+delete\b/i },
];

function irreversibleKeyword(action: string): string | null {
  return IRREVERSIBLE_ACTIONS.find((rule) => rule.pattern.test(action))?.keyword ?? null;
}

function objectiveApproves(objective: string, keyword: string): boolean {
  if (!objective.includes(keyword)) return false;
  const negated = new RegExp(`\\b(?:do not|don't|never|must not|without)\\b[^.\\n]{0,24}\\b${keyword}`, "i");
  return !negated.test(objective);
}

function forbiddenFindings(
  brief: DelegationBrief,
  files: string[],
  actions: string[],
): DelegationFinding[] {
  const findings: DelegationFinding[] = [];
  const objective = `${brief.objective} ${brief.context ?? ""}`.toLowerCase();
  for (const entry of brief.forbidden ?? []) {
    const normalized = normalizePath(entry);
    const fileHit = files.some((file) => isUnder(file, normalized));
    const actionHit = actions.some((action) => action.toLowerCase().includes(entry.toLowerCase()));
    if (!fileHit && !actionHit) continue;
    findings.push({
      code: "forbidden_action",
      severity: /push|merge|publish|release|delete/i.test(entry) ? "P0" : "P1",
      detail: `Observed a forbidden action or path: ${entry}.`,
      action: "Do not accept the result; confirm the irreversible step with the user or revert it.",
    });
  }
  for (const action of actions) {
    const keyword = irreversibleKeyword(action);
    if (!keyword || objectiveApproves(objective, keyword)) continue;
    if ((brief.forbidden ?? []).some((entry) => action.toLowerCase().includes(entry.toLowerCase()))) continue;
    findings.push({
      code: "unapproved_irreversible_action",
      severity: "P0",
      detail: `The delegate performed an irreversible action that the objective did not authorize: ${action}.`,
      action: "Stop and ask the user; do not repeat, extend, or report the action as complete.",
    });
  }
  return findings;
}

function failureFindings(
  observation: DelegationObservation,
  attempts: number,
  maxAttempts: number,
): DelegationFinding[] {
  const findings: DelegationFinding[] = [];
  const denials = observation.permission_denials ?? [];
  if (denials.length > 0 || observation.status === "blocked") {
    findings.push({
      code: "permission_denied",
      severity: "P1",
      detail: denials.length > 0
        ? `The delegate was denied: ${denials.slice(0, 5).join(" | ")}`
        : "The delegate reported a blocker before completing.",
      action: "Stop retrying the denied call. Decide whether to grant exactly that operation, change the brief, or run it yourself.",
    });
  }
  if (observation.status === "cancelled") {
    findings.push({
      code: "delegate_cancelled",
      severity: "P1",
      detail: "The delegation was cancelled before a successful terminal result.",
      action: "Decide whether to restart it, narrow it, or finish the work directly.",
    });
  }
  if (observation.status === "error") {
    if (attempts < maxAttempts) {
      findings.push({
        code: "transient_failure",
        severity: "P2",
        detail: `Delegate failed on attempt ${attempts + 1} of ${maxAttempts}: ${observation.error ?? observation.summary ?? "no error detail"}`,
        action: "Retry once with the failure detail folded into the brief.",
      });
    } else {
      findings.push({
        code: "retry_exhausted",
        severity: "P1",
        detail: `Delegate failed ${attempts} time(s); the retry budget is spent.`,
        action: "Decide whether to change the target, mode, or scope, or finish the work directly.",
      });
    }
  }
  return findings;
}

function verdictFor(findings: DelegationFinding[]): "accept" | "retry" | "escalate" {
  if (findings.some((finding) => ESCALATE_CODES.has(finding.code))) return "escalate";
  if (findings.some((finding) => RETRY_CODES.has(finding.code))) return "retry";
  return "accept";
}

function nextActionsFor(verdict: DelegationReview["verdict"], findings: DelegationFinding[]): string[] {
  if (verdict === "pending") return ["Wait for the delegate to finish, then call delegation_review again."];
  if (verdict === "accept") return ["Report the verified acceptance ids and the changed files as the delegate's observed result."];
  if (verdict === "retry") return ["Dispatch adaptation.revised_brief when present (otherwise the same brief for a transient failure), then verify again with delegation_review."];
  return findings.filter((finding) => finding.severity !== "P2").map((finding) => finding.action);
}

// ── Self-adaptation ───────────────────────────────────────────────────────
//
// The third outcome of a review is a doctrine change: the coordinator learns
// from the finding instead of re-sending the same failed handoff. A lesson is
// scoped to the task by default; a recurring lesson, or a P0 safety finding,
// is promoted to the coordinator's procedure.

const DOCTRINE_LESSONS: Record<string, string> = {
  permission_denied:
    "Preflight the delegate's permission mode before dispatch. A non-read-only handoff under default/dontAsk/plan stalls on the first write; choose an explicit mode and never retry a denied command.",
  permission_mode_denies_writes:
    "Preflight the delegate's permission mode before dispatch. A non-read-only handoff under default/dontAsk/plan auto-denies writes; choose an explicit mode or make the brief read-only.",
  out_of_scope_change:
    "List every path the acceptance commands may touch in scope_paths. A delegate will follow its own judgment outside an unstated scope.",
  read_only_violation:
    "A read-only brief must forbid mutations explicitly and verify that changed_files is empty before accepting.",
  forbidden_action:
    "State the allowed irreversible actions explicitly. A delegate must never infer push, merge, publish, release, or branch deletion.",
  unapproved_irreversible_action:
    "State the allowed irreversible actions explicitly and reject a result that performs one the objective did not authorize.",
  missing_validation_evidence:
    "Every acceptance criterion must name an exact command and require its exit code. A delegate's prose is not evidence.",
  failed_acceptance:
    "Retry with the failing output and the exact command. Do not ask the delegate to 'fix it' without the failing evidence.",
  transient_failure:
    "Re-dispatch the same brief for a transient failure; do not rewrite scope or acceptance for an infrastructure fault.",
  retry_exhausted:
    "After the retry budget, change the target, split the task, or finish it directly. Do not re-dispatch the same brief.",
  delegate_cancelled:
    "A cancelled delegation needs a user decision before it is restarted; a cancel is not a transient failure.",
};

function doctrineFor(
  code: string,
  severity: DelegationSeverity,
  previousFindings: readonly string[],
): DelegationDoctrine | null {
  const lesson = DOCTRINE_LESSONS[code];
  if (!lesson) return null;
  const recurring = previousFindings.includes(code);
  return {
    code,
    lesson,
    recurring,
    persist: recurring || severity === "P0" ? "skill" : "task",
  };
}

function revisedBriefForRetry(
  brief: DelegationBrief,
  finding: DelegationFinding,
): { revised: DelegationBrief; changes: DelegationAdaptation["changes"] } {
  const guidance = finding.code === "missing_validation_evidence"
    ? "Run every acceptance command exactly as written and return its exit code and output."
    : "Correct the failing evidence, re-run the exact acceptance command, and return the new exit code and output.";
  const suffix = `## Previous attempt\n${finding.detail}\n${guidance}`;
  const context = `${brief.context ? `${brief.context}\n\n` : ""}${suffix}`.slice(0, 8_000);
  return {
    revised: { ...brief, context },
    changes: [{ field: "context", reason: `${finding.code}: ${finding.detail}`.slice(0, 500) }],
  };
}

function adaptationFor(
  brief: DelegationBrief,
  verdict: DelegationReview["verdict"],
  findings: readonly DelegationFinding[],
  previousFindings: readonly string[],
): DelegationAdaptation {
  if (verdict === "accept") {
    return { action: "none", revised_brief: null, changes: [], requires_user: false, doctrine: null, next_actions: [] };
  }
  if (verdict === "pending") {
    return {
      action: "review",
      revised_brief: null,
      changes: [],
      requires_user: false,
      doctrine: null,
      next_actions: ["Wait for the delegate to finish, then call delegation_review again."],
    };
  }

  const escalation = findings.find((finding) => ESCALATE_CODES.has(finding.code));
  if (escalation) {
    return {
      action: escalation.code === "delegate_cancelled" ? "stop" : "escalate",
      revised_brief: null,
      changes: [],
      requires_user: true,
      doctrine: doctrineFor(escalation.code, escalation.severity, previousFindings),
      next_actions: [escalation.action],
    };
  }

  const retry = findings.find((finding) => RETRY_CODES.has(finding.code));
  if (!retry) {
    return {
      action: "escalate",
      revised_brief: null,
      changes: [],
      requires_user: true,
      doctrine: null,
      next_actions: ["A human decision is required before retrying."],
    };
  }

  if (retry.code === "transient_failure") {
    return {
      action: "retry",
      revised_brief: null,
      changes: [],
      requires_user: false,
      doctrine: doctrineFor(retry.code, retry.severity, previousFindings),
      next_actions: ["Re-dispatch the same brief; the failure was transient."],
    };
  }

  const { revised, changes } = revisedBriefForRetry(brief, retry);
  return {
    action: "revise_brief",
    revised_brief: revised,
    changes,
    requires_user: false,
    doctrine: doctrineFor(retry.code, retry.severity, previousFindings),
    next_actions: ["Dispatch the revised brief (a new brief id) and verify it again with delegation_review."],
  };
}

export function reviewDelegation(input: DelegationReviewInput): DelegationReview {
  const { brief, observation } = input;
  const attempts = observation.attempts ?? 0;
  const maxAttempts = input.maxAttempts ?? 3;
  const files = [...new Set((observation.changed_files ?? []).map(normalizePath).filter(Boolean))];

  if (observation.status === "running") {
    return {
      verdict: "pending",
      findings: [],
      verified_acceptance: [],
      unverified_acceptance: brief.acceptance.map((item) => item.id),
      changed_files: files,
      next_actions: nextActionsFor("pending", []),
      user_decision: null,
      adaptation: adaptationFor(brief, "pending", [], input.previousFindings ?? []),
    };
  }

  const assessment = observation.status === "done"
    ? assessAcceptance(brief, observation.verification ?? [])
    : { verified: [], unverified: brief.acceptance.map((item) => item.id), findings: [] };
  const findings = [
    ...failureFindings(observation, attempts, maxAttempts),
    ...(observation.status === "done"
      ? [
          ...assessment.findings,
          ...scopeFindings(brief, files),
          ...forbiddenFindings(brief, files, observation.actions ?? []),
        ]
      : []),
  ];
  if (attempts >= maxAttempts && findings.some((finding) => RETRY_CODES.has(finding.code))) {
    findings.push({
      code: "retry_exhausted",
      severity: "P1",
      detail: `The retry budget is spent (${attempts} of ${maxAttempts}) and acceptance evidence is still missing or failing.`,
      action: "Decide whether to change the target, mode, or scope, or finish the work directly.",
    });
  }
  const verdict = verdictFor(findings);
  const escalation = findings.find((finding) => finding.severity !== "P2" && finding.action);

  return {
    verdict,
    findings,
    verified_acceptance: assessment.verified,
    unverified_acceptance: assessment.unverified,
    changed_files: files,
    next_actions: nextActionsFor(verdict, findings),
    user_decision: verdict === "escalate" ? escalation?.action ?? "A human decision is required." : null,
    adaptation: adaptationFor(brief, verdict, findings, input.previousFindings ?? []),
  };
}

// ── Cadence ───────────────────────────────────────────────────────────────

export const DelegationRecordSchema = z.object({
  id: z.string().trim().min(1).max(200),
  target: z.enum(DELEGATION_TARGETS),
  status: z.enum(["running", "done", "error", "blocked", "cancelled"]),
  started_at: z.string().trim().max(40).optional(),
  updated_at: z.string().trim().max(40).optional(),
  attempts: z.number().int().min(0).max(20).optional(),
  verified: z.boolean().optional(),
  blocked_reason: z.string().max(1_000).optional(),
}).strict();

export type DelegationRecord = z.infer<typeof DelegationRecordSchema>;

export type DelegationCadenceAction = "review" | "retry" | "stop_retry" | "escalate";

export interface DelegationDecision {
  id: string;
  delegation_id: string;
  target: DelegationTarget;
  severity: DelegationSeverity;
  code: string;
  title: string;
  detail: string;
  owner: string;
  action: string;
  /** The unattended next step; anything not listed here is a user decision. */
  adaptation: DelegationCadenceAction;
}

export interface DelegationCadenceInput {
  records: DelegationRecord[];
  now?: string;
  staleAfterMinutes?: number;
  maxAttempts?: number;
}

export interface DelegationCadence {
  generated_at: string;
  decisions: DelegationDecision[];
  no_change: boolean;
  note: string;
}

const SEVERITY_ORDER: Record<DelegationSeverity, number> = { P0: 0, P1: 1, P2: 2 };

function decision(
  record: DelegationRecord,
  code: string,
  severity: DelegationSeverity,
  title: string,
  detail: string,
  action: string,
  adaptation: DelegationCadenceAction,
): DelegationDecision {
  return {
    id: `${code}:${record.id}`,
    delegation_id: record.id,
    target: record.target,
    severity,
    code,
    title,
    detail,
    owner: "chief of staff",
    action,
    adaptation,
  };
}

function ageMinutes(record: DelegationRecord, now: Date): number | null {
  const raw = record.updated_at ?? record.started_at;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((now.getTime() - parsed) / 60_000)) : null;
}

export function rankDelegationCadence(input: DelegationCadenceInput): DelegationCadence {
  const now = input.now ? new Date(input.now) : new Date();
  const staleAfter = input.staleAfterMinutes ?? 30;
  const maxAttempts = input.maxAttempts ?? 3;
  const decisions: DelegationDecision[] = [];

  for (const record of input.records) {
    const attempts = record.attempts ?? 0;
    if (record.status === "blocked") {
      decisions.push(decision(record, "delegation_blocked", "P1",
        `Delegation ${record.id} is blocked`,
        record.blocked_reason ? `Reported blocker: ${record.blocked_reason}` : "No blocker reason was recorded.",
        "Resolve the blocker or change the delegation; do not retry the same denied action.",
        "escalate"));
    } else if (record.status === "cancelled") {
      decisions.push(decision(record, "delegation_cancelled", "P1",
        `Delegation ${record.id} was cancelled`,
        "No successful terminal result was recorded.",
        "Decide whether to restart it, narrow it, or finish the work directly.",
        "escalate"));
    } else if (record.status === "error") {
      const retryable = attempts < maxAttempts;
      decisions.push(decision(record, retryable ? "delegation_failed_retryable" : "delegation_retry_exhausted",
        retryable ? "P2" : "P1",
        `Delegation ${record.id} failed`,
        `Attempts: ${attempts} of ${maxAttempts}.`,
        retryable ? "Retry with the failure detail in the brief." : "Change the target, mode, or scope, or finish the work directly.",
        retryable ? "retry" : "escalate"));
    } else if (record.status === "running") {
      const age = ageMinutes(record, now);
      if (age === null || age >= staleAfter) {
        decisions.push(decision(record, "delegation_stalled", "P1",
          `Delegation ${record.id} has no recent update`,
          age === null ? "No timestamp is available to prove it is alive." : `Last update ${age} minutes ago (threshold ${staleAfter}).`,
          "Check the delegate status; stop it and revise the brief if it is stuck on an approval or a loop.",
          "stop_retry"));
      }
    } else if (!record.verified) {
      decisions.push(decision(record, "delegation_unverified", "P1",
        `Delegation ${record.id} finished but was not verified`,
        "A completed delegate call is not proof the task is complete.",
        "Run delegation_review against the brief and observed evidence before reporting success.",
        "review"));
    }
  }

  decisions.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || left.id.localeCompare(right.id));

  return {
    generated_at: now.toISOString(),
    decisions,
    no_change: decisions.length === 0,
    note: decisions.length === 0
      ? "No open delegation needs a decision; running work is within the stale window and completed work is verified."
      : `${decisions.length} delegation decision(s) require attention.`,
  };
}
