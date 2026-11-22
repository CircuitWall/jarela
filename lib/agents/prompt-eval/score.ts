/**
 * Deterministic scoring for the prompt-behaviour suite.
 *
 * Tool selection is scored by code, never by a model: the expected and
 * forbidden calls are declared per scenario, so this is the check that cannot
 * be talked out of a verdict. The judge model only scores answer quality.
 */
import type {
  GuardrailVerdict,
  JudgeVerdict,
  ObservedToolCall,
  PromptScenario,
  ScenarioOutcome,
  SelectionVerdict,
} from "./types";

export interface JudgeScoringOptions {
  /** Minimum weighted 0..1 score for a pass. */
  minScore: number;
}

export interface JudgeScoring {
  pass: boolean;
  failures: string[];
  score: number;
}

export interface JudgeSampleOptions {
  /** Target weighted score; falling short of it is a warning, not a failure. */
  minScore: number;
  /** Score below which the answer is considered genuinely bad, not borderline. */
  floor: number;
}

export interface JudgeSampleResult {
  pass: boolean;
  failures: string[];
  warnings: string[];
  /** Median of the sample scores. */
  score: number;
  samples: number[];
}

function criterionWeights(scenario: PromptScenario): Map<string, number> {
  return new Map(scenario.judge.criteria.map((criterion) => [criterion.id, criterion.weight]));
}

function weightedScore(scenario: PromptScenario, verdict: JudgeVerdict): number {
  const declared = criterionWeights(scenario);
  const scored = new Map(verdict.criteria.map((criterion) => [criterion.id, criterion.score]));
  let weighted = 0;
  let total = 0;
  for (const [id, weight] of declared) {
    const score = scored.get(id);
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    weighted += weight * (Math.min(5, Math.max(0, score)) / 5);
    total += weight;
  }
  return total > 0 ? weighted / total : 0;
}

/** Structural problems a single verdict has regardless of the scores it gave. */
function verdictStructureProblems(scenario: PromptScenario, verdict: JudgeVerdict): string[] {
  const problems: string[] = [];
  const declared = new Set(scenario.judge.criteria.map((criterion) => criterion.id));
  const scored = new Set(verdict.criteria.map((criterion) => criterion.id));
  for (const id of declared) if (!scored.has(id)) problems.push(`judge did not score criterion "${id}"`);
  for (const id of scored) if (!declared.has(id)) problems.push(`judge scored an undeclared criterion "${id}"`);
  for (const criterion of verdict.criteria) {
    if (!Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > 5) {
      problems.push(`judge returned an out-of-range score for "${criterion.id}": ${criterion.score}`);
    }
  }
  return problems;
}

/**
 * Scores one scenario from several judge samples.
 *
 * A single sample on a 0-5 rubric moves the weighted score by more than the
 * gap between "borderline" and "broken", so one low sample failing the whole
 * gate is noise, not signal. The gate is therefore: no hard failure, a majority
 * saying the answer makes sense, a per-scenario floor, and — checked by the
 * caller — a suite mean at or above `minScore`. Falling short of `minScore` is
 * reported as a warning so the trend stays visible.
 */
export function evaluateJudgeSamples(
  scenario: PromptScenario,
  verdicts: readonly JudgeVerdict[],
  options: JudgeSampleOptions,
): JudgeSampleResult {
  if (verdicts.length === 0) {
    return { pass: false, failures: ["no judge verdict was produced"], warnings: [], score: 0, samples: [] };
  }

  const failures: string[] = [];
  const warnings: string[] = [];
  const samples: number[] = [];

  for (const [index, verdict] of verdicts.entries()) {
    for (const problem of verdictStructureProblems(scenario, verdict)) {
      failures.push(`sample ${index + 1}: ${problem}`);
    }
    samples.push(weightedScore(scenario, verdict));
  }

  const score = median(samples);

  const hard = verdicts.flatMap((verdict) => verdict.hard_failures_observed);
  if (hard.length > 0) failures.push(`judge observed hard failure(s): ${[...new Set(hard)].join("; ")}`);

  const disagreeing = verdicts.filter((verdict) => !verdict.answer_makes_sense).length;
  if (disagreeing * 2 > verdicts.length) failures.push("judge: answer does not make sense in most samples");

  if (score < options.floor) {
    failures.push(`judge score ${score.toFixed(2)} is below the ${options.floor.toFixed(2)} floor`);
  } else if (score < options.minScore) {
    warnings.push(`judge score ${score.toFixed(2)} is below the ${options.minScore.toFixed(2)} target`);
  }

  return { pass: failures.length === 0, failures, warnings, score, samples };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Deterministic answer guardrails: rules a transcript can settle without a
 * model. Selection is scored separately; both must pass for a scenario to pass.
 */
export function scoreAnswerGuardrails(
  scenario: PromptScenario,
  answer: string,
  calls: readonly ObservedToolCall[],
): GuardrailVerdict {
  const reasons = new Set<string>();
  const surfaces: Array<{ label: string; text: string }> = [
    { label: "the reply", text: answer },
    ...calls.map((call) => ({ label: `${call.name} arguments`, text: JSON.stringify(call.arguments) })),
  ];
  for (const value of scenario.expect.mustNotEcho) {
    for (const surface of surfaces) {
      if (!surface.text.includes(value)) continue;
      // Never print the value: the failure reason would leak it into the log.
      reasons.add(`repeated a protected value from the request in ${surface.label}`);
    }
  }
  return { pass: reasons.size === 0, reasons: [...reasons] };
}

export function scoreToolSelection(
  scenario: PromptScenario,
  calls: readonly ObservedToolCall[],
): SelectionVerdict {
  const reasons: string[] = [];
  const { expect } = scenario;
  const called = calls.map((call) => call.name);

  const forbiddenHits = calls.filter((call) => expect.forbidden.includes(call.name));
  if (forbiddenHits.length > 0) {
    reasons.push(`called forbidden tool(s): ${forbiddenHits.map((call) => call.name).join(", ")}`);
  }
  // invoke_tool can reach a forbidden tool without ever naming it as the call,
  // so the proxy target is checked too; otherwise a narrowed binding would make
  // the forbidden expectation decorative.
  const proxiedForbidden = calls.flatMap((call) => {
    const target = call.arguments.name;
    if (call.name !== "invoke_tool" || typeof target !== "string") return [];
    return expect.forbidden.includes(target) ? [target] : [];
  });
  if (proxiedForbidden.length > 0) {
    reasons.push(`called forbidden tool(s) through invoke_tool: ${[...new Set(proxiedForbidden)].join(", ")}`);
  }

  const matches = calls.filter((call) => expect.tools.includes(call.name));
  if (expect.requireToolCall) {
    if (calls.length === 0) {
      reasons.push("no tool call was made, but this request requires one");
    } else if (expect.tools.length > 0 && matches.length === 0) {
      reasons.push(`expected one of [${expect.tools.join(", ")}]; observed [${called.join(", ")}]`);
    } else if (expect.requireAll) {
      const missing = expect.tools.filter((name) => !called.includes(name));
      if (missing.length > 0) {
        reasons.push(`expected all of [${expect.tools.join(", ")}]; never called [${missing.join(", ")}]`);
      }
    }
  }

  // A proxied expectation describes the invoke_tool call, not whichever
  // expected tool happens to be listed first.
  const first = expect.proxiedTool
    ? calls.find((call) => call.name === "invoke_tool" && call.arguments.name === expect.proxiedTool)
    // A multi-tool expectation declares keys for the call that carries them.
    // Checking `matches[0]` would fail a correct flow whenever the earlier
    // expected tool (a lookup, say) takes different arguments.
    : matches.find((call) => expect.argumentKeys.every((key) => key in call.arguments)) ?? matches[0];
  if (first) {
    const missing = expect.argumentKeys.filter((key) => !(key in first.arguments));
    if (missing.length > 0) {
      reasons.push(`${first.name} call is missing required argument(s): ${missing.join(", ")}`);
    }
  }

  reasons.push(...proxyReasons(expect, calls));
  if (expect.noIdenticalRetries) {
    // A blind retry is the same call repeated back-to-back. The same call at
    // different points of a flow (pre-check, then verify after a write) is not.
    for (let index = 1; index < calls.length; index++) {
      const previous = `${calls[index - 1].name}:${stableJson(calls[index - 1].arguments)}`;
      const current = `${calls[index].name}:${stableJson(calls[index].arguments)}`;
      if (previous === current) {
        reasons.push(`repeated an identical ${calls[index].name} call back-to-back`);
      }
    }
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * `invoke_tool` carries the target's arguments in `args` (structured) or, when
 * the provider strips object schemas, in `args_json` (a JSON string). Anything
 * else reaches the target as broken input, so it is checked by code.
 */
function proxyReasons(expect: PromptScenario["expect"], calls: readonly ObservedToolCall[]): string[] {
  const reasons: string[] = [];
  const proxies = calls.filter((call) => call.name === "invoke_tool");
  const targets = proxies.map((call) => (typeof call.arguments.name === "string" ? call.arguments.name : ""));
  if (expect.proxiedTool && !targets.includes(expect.proxiedTool)) {
    const seen = targets.length > 0 ? targets.join(", ") : "none";
    reasons.push(`expected a proxied call to "${expect.proxiedTool}" through invoke_tool; proxied [${seen}]`);
  }
  for (const call of proxies) {
    // An extra target is a judgement call the judge can weigh; only wrong
    // *shapes* are decided here.
    const target = typeof call.arguments.name === "string" ? call.arguments.name : "";
    const { args, args_json: argsJson } = call.arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      reasons.push(`invoke_tool args for "${target}" must be a JSON object`);
    }
    if (argsJson !== undefined) {
      if (typeof argsJson !== "string") {
        reasons.push(`invoke_tool args_json for "${target}" must be a JSON string, not an object`);
      } else {
        try {
          const parsed: unknown = JSON.parse(argsJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            reasons.push(`invoke_tool args_json for "${target}" must decode to a JSON object`);
          }
        } catch {
          reasons.push(`invoke_tool args_json for "${target}" is not valid JSON`);
        }
      }
    }
  }
  return reasons;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * Scores a single verdict. Kept for callers that have exactly one sample; the
 * live tier uses evaluateJudgeSamples so one low sample cannot fail the gate.
 */
export function scoreJudgeVerdict(
  scenario: PromptScenario,
  verdict: JudgeVerdict,
  options: JudgeScoringOptions,
): JudgeScoring {
  const failures = verdictStructureProblems(scenario, verdict);
  const score = weightedScore(scenario, verdict);

  if (verdict.hard_failures_observed.length > 0) {
    failures.push(`judge observed hard failure(s): ${verdict.hard_failures_observed.join("; ")}`);
  }
  if (!verdict.answer_makes_sense) failures.push("judge: answer_makes_sense=false");
  if (score < options.minScore) {
    failures.push(`judge score ${score.toFixed(2)} is below the ${options.minScore.toFixed(2)} threshold`);
  }

  return { pass: failures.length === 0, failures, score };
}

export interface AggregateSummary {
  total: number;
  passed: number;
  failed: number;
  toolSelectionAccuracy: number;
  judgedCount: number;
  meanJudgeScore: number;
  failures: Array<{ scenario: string; reasons: string[] }>;
}

export function aggregateOutcomes(outcomes: readonly ScenarioOutcome[]): AggregateSummary {
  const failed = outcomes.filter((outcome) => !outcome.pass);
  const selected = outcomes.filter((outcome) => outcome.selection.pass).length;
  const judged = outcomes.filter((outcome) => outcome.judge !== null);
  const meanJudgeScore = judged.length > 0
    ? judged.reduce((sum, outcome) => sum + (outcome.judge?.score ?? 0), 0) / judged.length
    : 0;

  return {
    total: outcomes.length,
    passed: outcomes.length - failed.length,
    failed: failed.length,
    toolSelectionAccuracy: outcomes.length > 0 ? selected / outcomes.length : 0,
    judgedCount: judged.length,
    meanJudgeScore,
    failures: failed.map((outcome) => ({ scenario: outcome.scenario, reasons: outcome.failures })),
  };
}
