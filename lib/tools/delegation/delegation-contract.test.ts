import { describe, expect, it } from "vitest";
import {
  briefId,
  DelegationBriefSchema,
  preflightBrief,
  rankDelegationCadence,
  renderDelegationPrompt,
  reviewDelegation,
  type DelegationBrief,
  type DelegationObservation,
} from "./delegation-contract";

function commandAcceptance(id = "lint") {
  return { id, description: "lint passes", kind: "command" as const, command: "npm run lint" };
}

function brief(overrides: Partial<DelegationBrief> = {}): DelegationBrief {
  return DelegationBriefSchema.parse({
    objective: "Add the cadence review",
    expected_output: "A passing lint run and the changed files",
    acceptance: [commandAcceptance()],
    target: "claude",
    permission_mode: "bypassPermissions",
    ...overrides,
  });
}

function observation(overrides: Partial<DelegationObservation> = {}): DelegationObservation {
  return {
    status: "done",
    changed_files: ["lib/tools/example.ts"],
    verification: [{ acceptance_id: "lint", command: "npm run lint", exit_code: 0 }],
    ...overrides,
  };
}

const cleanGit = { is_repo: true, branch: "feat/cadence", dirty: false };

function context(overrides: Partial<Parameters<typeof preflightBrief>[1]> = {}) {
  return {
    safetyMode: "mostly_safe" as const,
    resolvedPermissionMode: "bypassPermissions",
    cwdProvided: true,
    git: cleanGit,
    ...overrides,
  };
}

describe("delegation brief schema", () => {
  it("requires the exact command for command acceptance and rejects one on manual acceptance", () => {
    expect(DelegationBriefSchema.safeParse({
      ...brief(),
      acceptance: [{ id: "lint", description: "lint", kind: "command" }],
    }).success).toBe(false);
    expect(DelegationBriefSchema.safeParse({
      ...brief(),
      acceptance: [{ id: "review", description: "review", kind: "manual", command: "npm run lint" }],
    }).success).toBe(false);
  });

  it("rejects duplicate acceptance ids", () => {
    const result = DelegationBriefSchema.safeParse({
      ...brief(),
      acceptance: [commandAcceptance("lint"), commandAcceptance("lint")],
    });
    expect(result.success).toBe(false);
  });

  it("keeps the brief id stable when acceptance order changes", () => {
    const left = brief({ acceptance: [commandAcceptance("a"), commandAcceptance("b")] });
    const right = brief({ acceptance: [commandAcceptance("b"), commandAcceptance("a")] });
    expect(briefId(left)).toBe(briefId(right));
  });
});

describe("delegation preflight", () => {
  it("blocks every target under JARELA_TOOL_SAFETY=safe", () => {
    const result = preflightBrief(brief(), context({ safetyMode: "safe" }));
    expect(result.ready).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "delegation_blocked", severity: "P0" }));
  });

  it("detects a Claude permission mode that will auto-deny writes", () => {
    const denied = preflightBrief(brief(), context({ resolvedPermissionMode: "dontAsk" }));
    expect(denied.ready).toBe(false);
    expect(denied.findings).toContainEqual(expect.objectContaining({ code: "permission_mode_denies_writes", severity: "P1" }));

    const readOnly = preflightBrief(brief({ read_only: true }), context({ resolvedPermissionMode: "dontAsk" }));
    expect(readOnly.ready).toBe(true);
  });

  it("warns that acceptEdits may still deny required shell commands", () => {
    const result = preflightBrief(brief(), context({ resolvedPermissionMode: "acceptEdits" }));
    expect(result.ready).toBe(true);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "permission_mode_may_deny_shell", severity: "P2" }));
  });

  it("blocks a non-read-only handoff whose work tree is on the default branch", () => {
    const result = preflightBrief(brief(), context({ git: { is_repo: true, branch: "main", dirty: false } }));
    expect(result.ready).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "on_default_branch", severity: "P1" }));

    const readOnly = preflightBrief(brief({ read_only: true }), context({ git: { is_repo: true, branch: "main", dirty: false } }));
    expect(readOnly.ready).toBe(true);
  });

  it("reports a dirty work tree as an advisory, not a blocker", () => {
    const result = preflightBrief(brief(), context({ git: { is_repo: true, branch: "feat/x", dirty: true } }));
    expect(result.ready).toBe(true);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "dirty_worktree", severity: "P2" }));
  });

  it("skips git checks without cwd and reports why", () => {
    const result = preflightBrief(brief(), context({ cwdProvided: false, git: null }));
    expect(result.ready).toBe(true);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "cwd_missing", severity: "P2" }));
  });

  it("reports a non-repository cwd", () => {
    const result = preflightBrief(brief(), context({ git: { is_repo: false } }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "git_not_repo", severity: "P2" }));
  });

  it("blocks contradictory scope and forbidden paths", () => {
    const result = preflightBrief(
      brief({ scope_paths: ["lib/tools/"], forbidden: ["lib/tools/"] }),
      context(),
    );
    expect(result.ready).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "scope_contradiction", severity: "P1" }));
  });

  it("renders the exact acceptance commands and the stop-on-denial rule", () => {
    const prompt = renderDelegationPrompt(brief(), "bypassPermissions");
    expect(prompt).toContain("npm run lint");
    expect(prompt).toContain("STOP retrying");
    expect(prompt).toContain("Runtime permission mode: bypassPermissions");
    expect(prompt).toContain("permission_denials");
  });
});

describe("delegation review", () => {
  it("accepts a completed delegation with verified evidence in scope", () => {
    const result = reviewDelegation({ brief: brief({ scope_paths: ["lib/tools/"] }), observation: observation() });
    expect(result.verdict).toBe("accept");
    expect(result.verified_acceptance).toEqual(["lint"]);
    expect(result.unverified_acceptance).toEqual([]);
    expect(result.adaptation).toMatchObject({ action: "none", requires_user: false });
  });

  it("does not accept a running delegation", () => {
    const result = reviewDelegation({ brief: brief(), observation: observation({ status: "running" }) });
    expect(result.verdict).toBe("pending");
  });

  it("escalates a permission denial with a user decision", () => {
    const result = reviewDelegation({
      brief: brief(),
      observation: observation({ status: "blocked", permission_denials: ["git switch -c chore/cadence-review"] }),
    });
    expect(result.verdict).toBe("escalate");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "permission_denied" }));
    expect(result.user_decision).toContain("denied");
  });

  it("retries when a required acceptance has no evidence", () => {
    const result = reviewDelegation({
      brief: brief({ acceptance: [commandAcceptance("lint"), commandAcceptance("test")] }),
      observation: observation(),
    });
    expect(result.verdict).toBe("retry");
    expect(result.unverified_acceptance).toContain("test");
  });

  it("retries on a command mismatch or a non-zero exit", () => {
    const mismatch = reviewDelegation({
      brief: brief(),
      observation: observation({ verification: [{ acceptance_id: "lint", command: "npm test", exit_code: 0 }] }),
    });
    expect(mismatch.verdict).toBe("retry");

    const failed = reviewDelegation({
      brief: brief(),
      observation: observation({ verification: [{ acceptance_id: "lint", command: "npm run lint", exit_code: 1, output: "eslint failed" }] }),
    });
    expect(failed.verdict).toBe("retry");
    expect(failed.findings).toContainEqual(expect.objectContaining({ code: "failed_acceptance" }));
  });

  it("accepts a manual acceptance only when the observation is recorded", () => {
    const manual = brief({ acceptance: [{ id: "inspect", description: "inspect", kind: "manual" }] });
    expect(reviewDelegation({ brief: manual, observation: observation({ verification: [{ acceptance_id: "inspect", observation: "checked the diff" }] }) }).verdict).toBe("accept");
    expect(reviewDelegation({ brief: manual, observation: observation({ verification: [{ acceptance_id: "inspect" }] }) }).verdict).toBe("retry");
  });

  it("escalates changes outside the declared scope", () => {
    const result = reviewDelegation({
      brief: brief({ scope_paths: ["lib/tools/"] }),
      observation: observation({ changed_files: ["lib/tools/example.ts", "docs/adr/0064.md"] }),
    });
    expect(result.verdict).toBe("escalate");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "out_of_scope_change" }));
  });

  it("escalates a read-only violation", () => {
    const result = reviewDelegation({ brief: brief({ read_only: true }), observation: observation() });
    expect(result.verdict).toBe("escalate");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "read_only_violation" }));
  });

  it("escalates an unauthorized push and accepts one the objective authorizes", () => {
    const unauthorized = reviewDelegation({
      brief: brief(),
      observation: observation({ actions: ["git push -u origin feat/cadence"] }),
    });
    expect(unauthorized.verdict).toBe("escalate");
    expect(unauthorized.findings).toContainEqual(expect.objectContaining({ code: "unapproved_irreversible_action", severity: "P0" }));

    const authorized = reviewDelegation({
      brief: brief({ objective: "Push a topic branch and open a PR" }),
      observation: observation({ actions: ["git push -u origin feat/cadence"] }),
    });
    expect(authorized.findings.some((finding) => finding.code === "unapproved_irreversible_action")).toBe(false);
  });

  it("escalates an explicitly forbidden action even when the objective mentions it", () => {
    const result = reviewDelegation({
      brief: brief({ objective: "Push a topic branch", forbidden: ["git push"] }),
      observation: observation({ actions: ["git push -u origin feat/x"] }),
    });
    expect(result.verdict).toBe("escalate");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "forbidden_action", severity: "P0" }));
  });

  it("retries a transient failure within budget and escalates once it is spent", () => {
    const retry = reviewDelegation({ brief: brief(), observation: observation({ status: "error", attempts: 1 }), maxAttempts: 3 });
    expect(retry.verdict).toBe("retry");
    expect(retry.findings).toContainEqual(expect.objectContaining({ code: "transient_failure", severity: "P2" }));

    const spent = reviewDelegation({ brief: brief(), observation: observation({ status: "error", attempts: 3 }), maxAttempts: 3 });
    expect(spent.verdict).toBe("escalate");
    expect(spent.findings).toContainEqual(expect.objectContaining({ code: "retry_exhausted" }));
  });

  it("escalates missing evidence once the retry budget is spent", () => {
    const result = reviewDelegation({
      brief: brief(),
      observation: observation({ verification: [], attempts: 3 }),
      maxAttempts: 3,
    });
    expect(result.verdict).toBe("escalate");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "retry_exhausted" }));
  });

  it("escalates a cancel rather than reporting success", () => {
    const result = reviewDelegation({ brief: brief(), observation: observation({ status: "cancelled" }) });
    expect(result.verdict).toBe("escalate");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "delegate_cancelled" }));
  });
});

describe("self-adaptation", () => {
  it("rewrites the brief for missing evidence and scopes the lesson to the task", () => {
    const result = reviewDelegation({
      brief: brief({ acceptance: [commandAcceptance("lint"), commandAcceptance("test")] }),
      observation: observation(),
    });
    expect(result.adaptation.action).toBe("revise_brief");
    expect(result.adaptation.revised_brief?.context).toContain("## Previous attempt");
    expect(result.adaptation.changes).toEqual([expect.objectContaining({ field: "context" })]);
    expect(result.adaptation.doctrine).toMatchObject({ code: "missing_validation_evidence", persist: "task" });
  });

  it("promotes a recurring lesson or a P0 finding to the skill", () => {
    const recurring = reviewDelegation({
      brief: brief({ acceptance: [commandAcceptance("lint"), commandAcceptance("test")] }),
      observation: observation(),
      previousFindings: ["missing_validation_evidence"],
    });
    expect(recurring.adaptation.doctrine).toMatchObject({ recurring: true, persist: "skill" });

    const p0 = reviewDelegation({
      brief: brief(),
      observation: observation({ actions: ["git push -u origin feat/x"] }),
    });
    expect(p0.adaptation).toMatchObject({ action: "escalate", requires_user: true });
    expect(p0.adaptation.doctrine).toMatchObject({ code: "unapproved_irreversible_action", persist: "skill" });
  });

  it("retries a transient failure with the same brief", () => {
    const result = reviewDelegation({ brief: brief(), observation: observation({ status: "error", attempts: 1 }), maxAttempts: 3 });
    expect(result.adaptation).toMatchObject({ action: "retry", revised_brief: null, requires_user: false });
  });

  it("never auto-adapts a permission denial or a cancel", () => {
    const denied = reviewDelegation({
      brief: brief(),
      observation: observation({ status: "blocked", permission_denials: ["git switch"] }),
    });
    expect(denied.adaptation).toMatchObject({ action: "escalate", requires_user: true });
    expect(denied.adaptation.revised_brief).toBeNull();

    const cancelled = reviewDelegation({ brief: brief(), observation: observation({ status: "cancelled" }) });
    expect(cancelled.adaptation).toMatchObject({ action: "stop", requires_user: true });
  });
});

describe("delegation cadence", () => {
  const now = "2026-11-28T10:00:00.000Z";

  it("ranks blocked, stalled, failed, and unverified work as decisions", () => {
    const result = rankDelegationCadence({
      now,
      staleAfterMinutes: 30,
      records: [
        { id: "blocked", target: "claude", status: "blocked", blocked_reason: "permission denied" },
        { id: "stalled", target: "codex", status: "running", updated_at: "2026-11-28T09:00:00.000Z" },
        { id: "failed", target: "copilot", status: "error", attempts: 1 },
        { id: "spent", target: "claude", status: "error", attempts: 3 },
        { id: "unverified", target: "agent", status: "done", verified: false },
        { id: "verified", target: "agent", status: "done", verified: true },
        { id: "fresh", target: "claude", status: "running", updated_at: "2026-11-28T09:50:00.000Z" },
      ],
    });
    expect(result.no_change).toBe(false);
    expect(result.decisions.map((item) => item.code)).toEqual([
      "delegation_blocked",
      "delegation_retry_exhausted",
      "delegation_stalled",
      "delegation_unverified",
      "delegation_failed_retryable",
    ]);
    expect(result.decisions[0]).toMatchObject({ severity: "P1", owner: "chief of staff" });
    expect(result.decisions.find((item) => item.code === "delegation_blocked")?.adaptation).toBe("escalate");
    expect(result.decisions.find((item) => item.code === "delegation_stalled")?.adaptation).toBe("stop_retry");
    expect(result.decisions.find((item) => item.code === "delegation_unverified")?.adaptation).toBe("review");
    expect(result.decisions.find((item) => item.code === "delegation_failed_retryable")?.adaptation).toBe("retry");
  });

  it("records no change when running work is fresh and completed work is verified", () => {
    const result = rankDelegationCadence({
      now,
      records: [
        { id: "fresh", target: "claude", status: "running", updated_at: "2026-11-28T09:50:00.000Z" },
        { id: "verified", target: "agent", status: "done", verified: true },
      ],
    });
    expect(result.no_change).toBe(true);
    expect(result.decisions).toEqual([]);
    expect(result.note).toContain("No open delegation needs a decision");
  });

  it("treats a running delegation without a timestamp as stalled", () => {
    const result = rankDelegationCadence({ now, records: [{ id: "unknown", target: "codex", status: "running" }] });
    expect(result.decisions).toContainEqual(expect.objectContaining({ code: "delegation_stalled", severity: "P1" }));
  });
});
