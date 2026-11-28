import { describe, expect, it } from "vitest";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { registeredCapability, registeredCategory } from "../runtime/registry";
import { delegationBriefTool, delegationCadenceTool, delegationReviewTool } from "./chief-of-staff";

const baseBrief = {
  objective: "Add the cadence review",
  expected_output: "A passing lint run and the changed files",
  acceptance: [{ id: "lint", description: "lint passes", kind: "command" as const, command: "npm run lint" }],
  target: "claude" as const,
  permission_mode: "bypassPermissions",
};

async function run(toolInstance: typeof delegationBriefTool, input: unknown): Promise<Record<string, unknown>> {
  return JSON.parse(String(await toolInstance.invoke(input as never))) as Record<string, unknown>;
}

describe("chief-of-staff tools", () => {
  it("registers three read-only Agent tools", () => {
    for (const name of ["delegation_brief", "delegation_review", "delegation_cadence"]) {
      expect(registeredCapability(name)).toBe("read");
      expect(registeredCategory(name)).toBe("Agent");
    }
  });

  it("emits strict schemas that reject unknown parameters", () => {
    for (const instance of [delegationBriefTool, delegationReviewTool, delegationCadenceTool]) {
      const parameters = convertToOpenAITool(instance).function.parameters as { additionalProperties?: boolean };
      expect(parameters.additionalProperties).toBe(false);
    }
  });

  it("preflights a clean handoff and renders the dispatch prompt", async () => {
    const result = await run(delegationBriefTool, baseBrief);
    expect(result.ok).toBe(true);
    expect(result.proceed).toBe(true);
    expect(result.brief_id).toMatch(/^[a-f0-9]{12}$/);
    expect(String(result.rendered_prompt)).toContain("npm run lint");
    expect(String(result.next_step)).toContain("claude_delegate");
    expect(result.preflight).toMatchObject({
      ready: true,
      findings: [expect.objectContaining({ code: "cwd_missing", severity: "P2" })],
    });
  });

  it("blocks a handoff whose Claude mode auto-denies writes", async () => {
    const result = await run(delegationBriefTool, { ...baseBrief, permission_mode: "dontAsk" });
    expect(result.proceed).toBe(false);
    expect(result.preflight).toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ code: "permission_mode_denies_writes" })]),
    });
  });

  it("blocks dispatch under the safe safety tier", async () => {
    const previous = process.env.JARELA_TOOL_SAFETY;
    process.env.JARELA_TOOL_SAFETY = "safe";
    try {
      const result = await run(delegationBriefTool, baseBrief);
      expect(result.proceed).toBe(false);
      expect(result.preflight).toMatchObject({
        findings: expect.arrayContaining([expect.objectContaining({ code: "delegation_blocked", severity: "P0" })]),
      });
    } finally {
      if (previous === undefined) delete process.env.JARELA_TOOL_SAFETY;
      else process.env.JARELA_TOOL_SAFETY = previous;
    }
  });

  it("returns actionable issues for a duplicate acceptance id", async () => {
    const result = await run(delegationBriefTool, {
      ...baseBrief,
      acceptance: [
        { id: "lint", description: "lint", kind: "command", command: "npm run lint" },
        { id: "lint", description: "again", kind: "command", command: "npm run lint" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "acceptance" })]));
  });

  it("accepts a verified result and escalates a permission denial", async () => {
    const accepted = await run(delegationReviewTool, {
      brief: baseBrief,
      observation: {
        status: "done",
        changed_files: ["lib/tools/example.ts"],
        verification: [{ acceptance_id: "lint", command: "npm run lint", exit_code: 0 }],
      },
    });
    expect(accepted).toMatchObject({ ok: true, verdict: "accept", verified_acceptance: ["lint"] });
    expect(accepted.adaptation).toMatchObject({ action: "none" });

    const blocked = await run(delegationReviewTool, {
      brief: baseBrief,
      observation: { status: "blocked", permission_denials: ["git switch -c chore/cadence-review"] },
    });
    expect(blocked).toMatchObject({ ok: true, verdict: "escalate" });
    expect(String(blocked.user_decision)).toContain("denied");
  });

  it("returns a revised brief and a recurring doctrine lesson", async () => {
    const result = await run(delegationReviewTool, {
      brief: {
        ...baseBrief,
        acceptance: [
          baseBrief.acceptance[0],
          { id: "tests", description: "tests pass", kind: "command", command: "npm test" },
        ],
      },
      observation: {
        status: "done",
        changed_files: ["lib/tools/example.ts"],
        verification: [{ acceptance_id: "lint", command: "npm run lint", exit_code: 0 }],
      },
      previous_findings: ["missing_validation_evidence"],
    });
    expect(result).toMatchObject({
      ok: true,
      verdict: "retry",
      adaptation: {
        action: "revise_brief",
        doctrine: { code: "missing_validation_evidence", recurring: true, persist: "skill" },
      },
    });
    expect((result.adaptation as { revised_brief?: { context?: string } }).revised_brief?.context)
      .toContain("## Previous attempt");
  });

  it("records an explicit no-change cadence result", async () => {
    const result = await run(delegationCadenceTool, {
      now: "2026-11-28T10:00:00.000Z",
      records: [{ id: "verified", target: "agent", status: "done", verified: true }],
    });
    expect(result).toMatchObject({ ok: true, no_change: true, decisions: [] });
  });

  it("ranks a stalled delegation as a P1 decision", async () => {
    const result = await run(delegationCadenceTool, {
      now: "2026-11-28T10:00:00.000Z",
      records: [{ id: "stalled", target: "claude", status: "running", updated_at: "2026-11-28T09:00:00.000Z" }],
    });
    expect(result.no_change).toBe(false);
    expect(result.decisions).toEqual([
      expect.objectContaining({ code: "delegation_stalled", severity: "P1", delegation_id: "stalled" }),
    ]);
  });
});
