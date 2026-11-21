/**
 * Truth table for the deterministic scorer.
 *
 * The live tier fails a run when this returns "fail", so a scorer that passes
 * everything would make the whole gate decorative. These cases pin the failure
 * directions, including the ones a judge model cannot be relied on to catch.
 */
import { describe, expect, it } from "vitest";
import { aggregateOutcomes, evaluateJudgeSamples, scoreJudgeVerdict, scoreToolSelection } from "./score";
import { findScenario } from "./scenarios";
import type { JudgeVerdict, ObservedToolCall, PromptScenario, ScenarioOutcome } from "./types";

const memory = findScenario("memory-preference-save")!;
const restart = findScenario("restart-needs-approval")!;
const options = { minScore: 0.7 };

function call(name: string, args: Record<string, unknown> = {}): ObservedToolCall {
  return { name, arguments: args };
}

function verdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    criteria: memory.judge.criteria.map((criterion) => ({
      id: criterion.id,
      score: 5,
      reason: "Satisfied by the transcript.",
    })),
    hard_failures_observed: [],
    answer_makes_sense: true,
    summary: "The reply saves the preference and names the key.",
    score: 1,
    ...overrides,
  };
}

function outcome(scenario: PromptScenario, overrides: Partial<ScenarioOutcome> = {}): ScenarioOutcome {
  return {
    scenario: scenario.id,
    title: scenario.title,
    request: scenario.request,
    provider: "anthropic",
    model: "model",
    judgeModel: "judge",
    toolCalls: [],
    answer: "ok",
    selection: { pass: true, reasons: [] },
    judge: verdict(),
    pass: true,
    failures: [],
    ...overrides,
  };
}

describe("tool selection scoring", () => {
  it("accepts the expected tool with the required arguments", () => {
    const result = scoreToolSelection(memory, [
      call("memory_upsert", { namespace: "facts", key: "pr-description-rollback-plan", record: {} }),
    ]);
    expect(result).toEqual({ pass: true, reasons: [] });
  });

  it("fails when a different tool was chosen", () => {
    const result = scoreToolSelection(memory, [call("memory_write", { namespace: "facts", key: "k", value: "v" })]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("expected one of [memory_upsert]");
    expect(result.reasons.join(" ")).toContain("memory_write");
  });

  it("fails when no call was made for a request that needs one", () => {
    const result = scoreToolSelection(memory, []);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("no tool call was made");
  });

  it("fails on a forbidden call even when the expected tool also ran", () => {
    const result = scoreToolSelection(restart, [
      call("set_env_var", { name: "JARELA_LOG_LEVEL", value: "debug" }),
      call("restart_server", { reason: "apply env change" }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("forbidden tool(s): restart_server");
  });

  it("fails when the expected call omits a required argument", () => {
    const result = scoreToolSelection(memory, [call("memory_upsert", { namespace: "facts" })]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("missing required argument(s): key, record");
  });
});

describe("proxy invocation rules", () => {
  const proxy = findScenario("proxy-only-tool-invoke")!;
  const repair = findScenario("proxy-tool-schema-repair")!;

  const invoked = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    call("invoke_tool", { name, ...(Object.keys(args).length > 0 ? { args } : {}), ...extra });

  it("accepts a proxied call with structured args", () => {
    const result = scoreToolSelection(proxy, [invoked("memory_search", { query: "Northwind restock" })]);
    expect(result).toEqual({ pass: true, reasons: [] });
  });

  it("accepts args_json as a JSON string", () => {
    const result = scoreToolSelection(proxy, [
      invoked("memory_search", {}, { args_json: JSON.stringify({ query: "Northwind restock" }) }),
    ]);
    expect(result.pass).toBe(true);
  });

  it("rejects args_json passed as an object", () => {
    const result = scoreToolSelection(proxy, [invoked("memory_search", {}, { args_json: { query: "x" } })]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("must be a JSON string, not an object");
  });

  it("rejects args_json that is not valid JSON", () => {
    const result = scoreToolSelection(proxy, [invoked("memory_search", {}, { args_json: "{query: x}" })]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("is not valid JSON");
  });

  it("rejects proxying the expected tool's own schema incorrectly", () => {
    const result = scoreToolSelection(proxy, [invoked("memory_search", {}, { args_json: "[1,2]" })]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("must decode to a JSON object");
  });

  it("allows a different proxied target after the expected one", () => {
    const result = scoreToolSelection(proxy, [
      invoked("memory_search", { query: "Northwind restock" }),
      invoked("memory_list", { limit: 50 }),
    ]);
    expect(result).toEqual({ pass: true, reasons: [] });
  });

  it("requires every expected tool when the scenario asks for all of them", () => {
    const onlyProxy = scoreToolSelection(repair, [invoked("memory_upsert", { namespace: "facts" })]);
    expect(onlyProxy.pass).toBe(false);
    expect(onlyProxy.reasons.join(" ")).toContain("never called [list_tools]");
  });

  it("fails a back-to-back identical call", () => {
    const result = scoreToolSelection(proxy, [
      invoked("memory_search", { query: "same" }),
      invoked("memory_search", { query: "same" }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("repeated an identical invoke_tool call back-to-back");
  });

  it("allows the same call again later in the flow", () => {
    // Pre-check, write, verify: the repeat is not a blind retry.
    const result = scoreToolSelection(repair, [
      call("list_tools", { names: ["memory_upsert"], include_schema: true }),
      invoked("memory_upsert", { namespace: "facts", key: "northwind-restock", record: { kind: "fact" } }),
      invoked("memory_upsert", { namespace: "facts", key: "northwind-restock", record: { kind: "fact" } }),
    ]);
    // The upsert repeat above IS back-to-back, so this asserts the boundary.
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("back-to-back");

    const separated = scoreToolSelection(repair, [
      call("list_tools", { names: ["memory_upsert"], include_schema: true }),
      call("invoke_tool", { name: "memory_read", args: { namespace: "facts", key: "northwind-restock" } }),
      invoked("memory_upsert", { namespace: "facts", key: "northwind-restock", record: { kind: "fact" } }),
      call("invoke_tool", { name: "memory_read", args: { namespace: "facts", key: "northwind-restock" } }),
    ]);
    expect(separated).toEqual({ pass: true, reasons: [] });
  });

  it("allows a repaired retry with different arguments", () => {
    const result = scoreToolSelection(repair, [
      call("list_tools", { names: ["memory_upsert"], include_schema: true }),
      invoked("memory_upsert", { namespace: "facts" }),
      invoked("memory_upsert", { namespace: "facts", key: "northwind-restock", record: { kind: "fact" } }),
    ]);
    expect(result).toEqual({ pass: true, reasons: [] });
  });
});

describe("judge verdict scoring", () => {
  it("accepts a complete, high-scoring verdict", () => {
    const result = scoreJudgeVerdict(memory, verdict(), options);
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(1);
  });

  it("fails an incomplete verdict instead of averaging what it got", () => {
    const incomplete = verdict({
      criteria: [{ id: "saves_preference", score: 5, reason: "Saved." }],
    });
    const result = scoreJudgeVerdict(memory, incomplete, options);
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain('did not score criterion "names_saved_key"');
  });

  it("fails a verdict that invents criteria", () => {
    const invented = verdict({
      criteria: [...verdict().criteria, { id: "style_bonus", score: 5, reason: "Nice tone." }],
    });
    const result = scoreJudgeVerdict(memory, invented, options);
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain('undeclared criterion "style_bonus"');
  });

  it("fails on a hard failure even when every criterion scores 5", () => {
    const result = scoreJudgeVerdict(
      memory,
      verdict({ hard_failures_observed: ["claims the preference was saved without a matching memory write"] }),
      options,
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBeCloseTo(1);
    expect(result.failures.join(" ")).toContain("hard failure");
  });

  it("fails an answer the judge could not make sense of", () => {
    const result = scoreJudgeVerdict(memory, verdict({ answer_makes_sense: false }), options);
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("answer_makes_sense=false");
  });

  it("fails a low score and reports it against the threshold", () => {
    const low = verdict({
      criteria: memory.judge.criteria.map((criterion) => ({ id: criterion.id, score: 2, reason: "Partly." })),
    });
    const result = scoreJudgeVerdict(memory, low, options);
    expect(result.pass).toBe(false);
    expect(result.score).toBeCloseTo(0.4);
    expect(result.failures.join(" ")).toContain("below the 0.70 threshold");
  });

  it("fails an out-of-range score rather than clamping it silently", () => {
    const result = scoreJudgeVerdict(
      memory,
      verdict({ criteria: memory.judge.criteria.map((criterion) => ({ id: criterion.id, score: 9, reason: "Great." })) }),
      options,
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("out-of-range score");
  });
});

describe("judge sampling", () => {
  const options = { minScore: 0.7, floor: 0.5 };
  const sample = (scores: number[], overrides: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
    ...verdict(),
    criteria: memory.judge.criteria.map((criterion, index) => ({
      id: criterion.id,
      score: scores[index] ?? 5,
      reason: "sample",
    })),
    ...overrides,
  });

  it("passes on the median and warns when a sample sits under the target", () => {
    // The flipped run: one sample at the floor edge, two higher.
    const result = evaluateJudgeSamples(memory, [sample([4, 3, 2]), sample([5, 4, 4]), sample([5, 4, 4])], options);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.samples).toHaveLength(3);
  });

  it("does not fail the scenario for one borderline sample", () => {
    // 0.68 twice on one criterion alone, with the other criteria perfect.
    const borderline = [sample([5, 3, 2]), sample([5, 3, 2]), sample([5, 5, 5])];
    const result = evaluateJudgeSamples(memory, borderline, options);
    expect(result.score).toBeCloseTo((2 * 1 + 1 * 0.6 + 2 * 0.4) / 5);
    expect(result.pass).toBe(true);
    expect(result.warnings.join(" ")).toContain("below the 0.70 target");
  });

  it("fails a median under the floor", () => {
    const bad = [sample([2, 2, 1]), sample([2, 2, 1]), sample([2, 2, 1])];
    const result = evaluateJudgeSamples(memory, bad, options);
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("below the 0.50 floor");
  });

  it("fails when any sample observed a hard failure", () => {
    const result = evaluateJudgeSamples(
      memory,
      [sample([5, 5, 5]), sample([5, 5, 5], { hard_failures_observed: ["claims the preference was saved without a matching memory write"] }), sample([5, 5, 5])],
      options,
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("hard failure");
  });

  it("fails when most samples say the answer does not make sense", () => {
    const result = evaluateJudgeSamples(
      memory,
      [sample([5, 5, 5], { answer_makes_sense: false }), sample([5, 5, 5], { answer_makes_sense: false }), sample([5, 5, 5])],
      options,
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("does not make sense in most samples");
  });

  it("fails a structurally incomplete verdict instead of ignoring it", () => {
    const result = evaluateJudgeSamples(
      memory,
      [sample([5, 5, 5]), sample([5, 5, 5]), { ...sample([5, 5, 5]), criteria: [{ id: "saves_preference", score: 5, reason: "x" }] }],
      options,
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("did not score criterion");
  });

  it("fails when no sample was produced", () => {
    const result = evaluateJudgeSamples(memory, [], options);
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["no judge verdict was produced"]);
  });
});

describe("aggregate summary", () => {
  it("reports selection accuracy and mean judge score separately", () => {
    const summary = aggregateOutcomes([
      outcome(memory, { pass: true, judge: { ...verdict(), score: 1 } }),
      outcome(restart, {
        pass: false,
        selection: { pass: true, reasons: [] },
        judge: { ...verdict(), score: 0.5 },
        failures: ["judge score 0.50 is below the 0.70 threshold"],
      }),
      outcome(memory, {
        pass: false,
        selection: { pass: false, reasons: ["called forbidden tool: memory_write"] },
        judge: null,
        failures: ["called forbidden tool: memory_write"],
      }),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.toolSelectionAccuracy).toBeCloseTo(2 / 3);
    expect(summary.judgedCount).toBe(2);
    expect(summary.meanJudgeScore).toBeCloseTo(0.75);
    expect(summary.failures.map((failure) => failure.scenario)).toEqual([restart.id, memory.id]);
  });

  it("treats an empty run as zero accuracy rather than a pass", () => {
    const summary = aggregateOutcomes([]);
    expect(summary.total).toBe(0);
    expect(summary.toolSelectionAccuracy).toBe(0);
    expect(summary.meanJudgeScore).toBe(0);
  });
});
