/**
 * The judge is a prompt plus a parser. Both halves have failure modes that
 * would silently weaken the gate: a prompt that never shows the output shape,
 * and a parser that treats an unparseable reply as approval.
 */
import { describe, expect, it } from "vitest";
import { JUDGE_SYSTEM_PROMPT, buildJudgeInput, buildJudgeMessages, parseJudgeVerdict } from "./judge";
import { PROMPT_SCENARIOS } from "./scenarios";

const scenario = PROMPT_SCENARIOS[0];

describe("judge prompt", () => {
  it("shows the exact output shape it demands", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('"criteria":[{"id":"criterion-id","score":0,"reason":"one short sentence"}]');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"hard_failures_observed":[]');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"answer_makes_sense":true');
    expect(JUDGE_SYSTEM_PROMPT).toContain("Return exactly one JSON object and nothing else");
  });

  it("states the score range the scorer enforces", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("from 0 to 5");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Score each id in criteria exactly once");
  });

  it("separates evidence from invention and forbids scoring hidden reasoning", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Treat them as the only evidence the agent had");
    expect(JUDGE_SYSTEM_PROMPT).toContain("hidden reasoning is out of scope");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Record a hard failure only when the transcript literally shows it");
  });

  it("scores fuzzy behaviour without re-judging the deterministic guardrails", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("cross-cutting behaviours that apply to every scenario");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Tool selection and argument shape are verified outside this rubric");
  });

  it("carries no unresolved template values", () => {
    expect(JUDGE_SYSTEM_PROMPT).not.toMatch(/\{\{[^}]+\}/);
    expect(JUDGE_SYSTEM_PROMPT).not.toMatch(/\bundefined\b/);
  });
});

describe("judge input", () => {
  it("hands the judge the declared criteria, expectations and fixture", () => {
    const input = buildJudgeInput(scenario, [{ name: "memory_upsert", arguments: { key: "k" } }], "Saved.");
    expect(input.expected_tool_calls).toEqual(scenario.expect.tools);
    expect(input.forbidden_tool_calls).toEqual(scenario.expect.forbidden);
    expect(input.criteria.map((criterion) => criterion.id)).toEqual(scenario.judge.criteria.map((criterion) => criterion.id));
    expect(input.hard_failures).toEqual(scenario.judge.hardFailures);
    expect(input.tool_results).toEqual([scenario.expect.toolResultFixture]);
    expect(input.observed_tool_calls).toEqual([{ name: "memory_upsert", arguments: { key: "k" } }]);
  });

  it("hands the judge the results the model actually received", () => {
    const input = buildJudgeInput(
      scenario,
      [{ name: "memory_upsert", arguments: { key: "k" } }],
      "Saved.",
      [
        { name: "memory_search", content: '{"results":[]}' },
        { name: "memory_upsert", content: '{"ok":true}' },
      ],
    );
    expect(input.tool_results).toEqual([
      'memory_search -> {"results":[]}',
      'memory_upsert -> {"ok":true}',
    ]);
  });

  it("falls back to the declared fixture when no results were recorded", () => {
    const input = buildJudgeInput(scenario, [], "answer");
    expect(input.tool_results).toEqual([scenario.expect.toolResultFixture]);
  });

  it("renders as a system turn plus one JSON user turn", () => {
    const messages = buildJudgeMessages(buildJudgeInput(scenario, [], "answer"));
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(() => JSON.parse(messages[1].content as string)).not.toThrow();
  });
});

describe("judge verdict parsing", () => {
  const valid = {
    criteria: scenario.judge.criteria.map((criterion) => ({ id: criterion.id, score: 4, reason: "Grounded." })),
    hard_failures_observed: [],
    answer_makes_sense: true,
    summary: "Fine.",
  };

  it("accepts a bare JSON object", () => {
    expect(parseJudgeVerdict(JSON.stringify(valid)).summary).toBe("Fine.");
  });

  it("accepts a fenced object, since models add fences anyway", () => {
    expect(parseJudgeVerdict("```json\n" + JSON.stringify(valid) + "\n```").answer_makes_sense).toBe(true);
  });

  it("rejects a reply with no JSON instead of passing it", () => {
    expect(() => parseJudgeVerdict("The answer looks good to me.")).toThrow(/no JSON object/);
  });

  it("rejects a reply that is not valid JSON", () => {
    expect(() => parseJudgeVerdict("{ criteria: nope }")).toThrow(/not valid JSON/);
  });

  it("rejects a reply missing required fields", () => {
    expect(() => parseJudgeVerdict(JSON.stringify({ criteria: valid.criteria }))).toThrow(/verdict shape/);
  });
});
