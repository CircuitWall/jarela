import { describe, expect, it } from "vitest";
import {
  defaultSkillExecutionPolicy, evaluateSkillExecutionPolicy, SkillExecutionPolicySchema,
  type SkillExecutionPolicy, type SkillExecutionTarget,
} from "./execution-policy";

const target: SkillExecutionTarget = {
  revision: "a".repeat(64), agent_id: "agent-1", workspace: "/workspace",
  timeout_ms: 60_000, max_output_bytes: 65_536,
};
const grant = {
  revision: target.revision, agent_id: target.agent_id, workspace: target.workspace,
  max_timeout_ms: 60_000, max_output_bytes: 65_536,
};
const policy = (): SkillExecutionPolicy => ({ mode: "trusted_revisions", trusted_revisions: [grant] });
const context = { safetyMode: "mostly_safe" as const, executeAllowed: true };

describe("skill execution consent policy", () => {
  it("defaults to invocation consent without implicit revision trust", () => {
    expect(defaultSkillExecutionPolicy()).toEqual({ mode: "ask_each_time", trusted_revisions: [] });
    expect(evaluateSkillExecutionPolicy(defaultSkillExecutionPolicy(), target, context))
      .toEqual({ kind: "require_invocation_consent" });
  });

  it.each(["blocked", "ask_each_time", "approve_workflow", "trusted_revisions"] as const)(
    "safe mode and execute capability dominate %s", (mode) => {
      expect(evaluateSkillExecutionPolicy({ ...policy(), mode }, target, { ...context, safetyMode: "safe" }).kind).toBe("blocked");
      expect(evaluateSkillExecutionPolicy({ ...policy(), mode }, target, { ...context, executeAllowed: false }).kind).toBe("blocked");
    },
  );

  it("does not interpret bypass as consent", () => {
    expect(evaluateSkillExecutionPolicy(defaultSkillExecutionPolicy(), target, { ...context, safetyMode: "bypass" }))
      .toEqual({ kind: "require_invocation_consent" });
    expect(evaluateSkillExecutionPolicy({ ...policy(), mode: "blocked" }, target, { ...context, safetyMode: "bypass" }).kind)
      .toBe("blocked");
  });

  it("requires workflow consent rather than granting execution", () => {
    expect(evaluateSkillExecutionPolicy({ ...policy(), mode: "approve_workflow" }, target, context))
      .toEqual({ kind: "require_workflow_consent" });
  });

  it("only exact revision/agent/workspace trust with bounded limits waives invocation consent", () => {
    expect(evaluateSkillExecutionPolicy(policy(), target, context)).toEqual({ kind: "trusted_revision" });
    expect(evaluateSkillExecutionPolicy(policy(), { ...target, timeout_ms: 1000, max_output_bytes: 1 }, context))
      .toEqual({ kind: "trusted_revision" });
  });

  it.each([
    { revision: "b".repeat(64) }, { agent_id: "other-agent" }, { workspace: "/other-workspace" },
    { workspace: "/WORKSPACE" }, { timeout_ms: 60_001 }, { max_output_bytes: 65_537 },
  ])("requires fresh consent outside the exact trust scope: %j", (change) => {
    expect(evaluateSkillExecutionPolicy(policy(), { ...target, ...change }, context))
      .toEqual({ kind: "require_invocation_consent" });
  });

  it("ignores retained trust entries in other modes", () => {
    expect(evaluateSkillExecutionPolicy({ ...policy(), mode: "ask_each_time" }, target, context))
      .toEqual({ kind: "require_invocation_consent" });
  });

  it.each([
    { mode: "bypass" }, { mode: "trusted_revisions", trusted_revisions: [{ ...grant, revision: "skill-name" }] },
    { mode: "ask_each_time", extra: true }, { mode: "trusted_revisions", trusted_revisions: [grant, grant] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...grant, max_timeout_ms: 120001 }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...grant, max_output_bytes: 262145 }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...grant, agent_id: " agent" }] },
    { mode: "trusted_revisions", trusted_revisions: [{ ...grant, executeAllowed: true }] },
  ])("rejects malformed or overbroad policy %j", (value) => {
    expect(SkillExecutionPolicySchema.safeParse(value).success).toBe(false);
  });

  it("caps trusted revision entries", () => {
    const entries = Array.from({ length: 64 }, (_, i) => ({ ...grant, agent_id: `agent-${i}` }));
    expect(SkillExecutionPolicySchema.parse({ mode: "trusted_revisions", trusted_revisions: entries }).trusted_revisions).toHaveLength(64);
    expect(SkillExecutionPolicySchema.safeParse({ mode: "trusted_revisions", trusted_revisions: [...entries, { ...grant, agent_id: "65" }] }).success).toBe(false);
  });
});
