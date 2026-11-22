/**
 * Live tier: a real model chooses tools, and a second model judges the answer.
 *
 * Gated because it spends tokens and needs a provider key. Enable it with:
 *
 *   JARELA_PROMPT_EVAL=1 \
 *   JARELA_PROMPT_EVAL_PROVIDER=anthropic \
 *   JARELA_PROMPT_EVAL_MODEL=<model-id> \
 *   ANTHROPIC_API_KEY=<key> \
 *   npm run test:prompt-eval
 *
 * `JARELA_PROMPT_EVAL_MODE=mock` runs the same pipeline against the mock
 * provider to prove the harness itself works; it says nothing about model
 * quality and is labelled as a self-test in the report.
 *
 * What the tier does NOT do: it never executes tools. Tool selection is scored
 * from the observed calls, then the declared `toolResultFixture` is fed back as
 * the only evidence so the judge can check whether the answer is grounded. That
 * keeps an evaluation run from restarting a server or writing to real memory.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InvokeMessage, InvokeResult, ModelProvider, OpenAITool } from "@/lib/providers/types";
import type { JudgeVerdict, ObservedToolCall, ScenarioOutcome } from "./types";

const mode = process.env.JARELA_PROMPT_EVAL_MODE === "mock" ? "mock" : "live";
if (mode === "mock") process.env.JARELA_ENABLE_MOCK_PROVIDER = "1";

const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

function resolveConfig() {
  if (mode === "mock") {
    return { provider: "mock", model: "mock-subject", judgeProvider: "mock", judgeModel: "mock-judge", key: "", judgeKey: "" };
  }
  const provider = process.env.JARELA_PROMPT_EVAL_PROVIDER ?? "anthropic";
  const model = process.env.JARELA_PROMPT_EVAL_MODEL ?? "";
  const judgeProvider = process.env.JARELA_PROMPT_EVAL_JUDGE_PROVIDER ?? provider;
  const judgeModel = process.env.JARELA_PROMPT_EVAL_JUDGE_MODEL ?? model;
  const key = process.env.JARELA_PROMPT_EVAL_API_KEY
    ?? process.env[PROVIDER_KEY_ENV[provider] ?? ""]
    ?? "";
  const judgeKey = process.env.JARELA_PROMPT_EVAL_JUDGE_API_KEY
    ?? (judgeProvider === provider ? key : process.env[PROVIDER_KEY_ENV[judgeProvider] ?? ""] ?? "");
  return { provider, model, judgeProvider, judgeModel, key, judgeKey };
}

const config = resolveConfig();
const explicitlyEnabled = process.env.JARELA_PROMPT_EVAL === "1" || mode === "mock";
// The mock self-test needs no credentials; a live run cannot invent them.
const missing = mode === "mock"
  ? []
  : [explicitIfEmpty("model", config.model), explicitIfEmpty("api key", config.key)].filter(Boolean);
const runnable = explicitlyEnabled && missing.length === 0;
// A typo in the threshold must not silently disable the gate.
const minJudgeScore = (() => {
  const parsed = Number(process.env.JARELA_PROMPT_EVAL_MIN_SCORE ?? "0.7");
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.7;
})();
/** Below this, an answer is broken rather than borderline. */
const judgeFloor = (() => {
  const parsed = Number(process.env.JARELA_PROMPT_EVAL_FLOOR ?? "0.5");
  return Number.isFinite(parsed) && parsed > 0 && parsed < minJudgeScore ? parsed : 0.5;
})();
/** Judge samples per scenario; the median decides. */
const judgeSamples = (() => {
  const parsed = Number(process.env.JARELA_PROMPT_EVAL_JUDGE_SAMPLES ?? "3");
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 3;
})();

function explicitIfEmpty(label: string, value: string): string | null {
  return value ? null : label;
}

if (!runnable) {
  // Visible in the job log so a skipped gate is never mistaken for a passing one.
  console.warn(
    "[prompt-eval] skipped: set JARELA_PROMPT_EVAL=1 plus JARELA_PROMPT_EVAL_MODEL and a provider key " +
      "(ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY), " +
      "or set JARELA_PROMPT_EVAL_MODE=mock for a harness self-test.",
  );
}

const { PROMPT_SCENARIOS } = await import("./scenarios");
const { buildScenarioPrompt } = await import("./assemble");
const { mapPool, resolveConcurrency } = await import("./concurrency");
const { scoreAnswerGuardrails, scoreToolSelection, evaluateJudgeSamples, aggregateOutcomes } = await import("./score");
const { buildJudgeInput, buildJudgeMessages, parseJudgeVerdict } = await import("./judge");
const { getProvider } = await import("@/lib/providers");
const { getAllTools, toOpenAITools } = await import("@/lib/tools");

/**
 * Mock mode proves the pipeline with a single scripted call, so scenarios that
 * require several tools (`requireAll`) cannot be self-tested that way. They are
 * still exercised by the real run and by score.test.ts.
 */
const activeScenarios = mode === "mock"
  ? PROMPT_SCENARIOS.filter((scenario) => !scenario.expect.requireAll)
  : PROMPT_SCENARIOS;

const outcomes: ScenarioOutcome[] = [];
const reportDir = join(process.cwd(), ".prompt-eval");
/** A turn is bounded: this many model rounds, then whatever answer exists.
 *  The documented flows are genuinely multi-step (search -> schema -> write ->
 *  verify), so the budget has to accommodate them. */
const MAX_ROUNDS = 8;
/** Scenario fan-out. The wait is provider round trips, so a small pool turns
 *  the wall time into roughly the tail instead of the sum. */
const concurrency = resolveConcurrency(process.env.JARELA_PROMPT_EVAL_CONCURRENCY);
/** Result for a call the scenario did not describe; clearly synthetic. */
const GENERIC_TOOL_RESULT = JSON.stringify({ ok: true, note: "synthetic evaluation result" });

function mockVerdict(scenario: (typeof PROMPT_SCENARIOS)[number]) {
  return JSON.stringify({
    criteria: scenario.judge.criteria.map((criterion) => ({
      id: criterion.id,
      score: 5,
      reason: "Self-test verdict: plumbing check only.",
    })),
    hard_failures_observed: [],
    answer_makes_sense: true,
    summary: "Self-test verdict; not a quality signal.",
  });
}

async function evaluate(scenario: (typeof PROMPT_SCENARIOS)[number]): Promise<ScenarioOutcome> {
  const assembled = await buildScenarioPrompt(scenario);
  const tools: OpenAITool[] = toOpenAITools(getAllTools({ allow: assembled.boundTools }));
  const subject = getProvider(config.provider);
  const judge = getProvider(config.judgeProvider);
  if (!subject.invoke) throw new Error(`provider "${config.provider}" does not implement invoke()`);
  if (!judge.invoke) throw new Error(`provider "${config.judgeProvider}" does not implement invoke()`);
  const invokeSubject = subject.invoke.bind(subject);
  const invokeJudge = judge.invoke.bind(judge);

  const firstRequest: InvokeMessage[] = [
    { role: "system", content: assembled.prompt },
    ...priorMessages(scenario),
    { role: "user", content: selectionPrompt(scenario) },
  ];
  const first = await invokeSubject(
    config.model,
    firstRequest,
    { api_key: config.key, temperature: 0 },
    tools,
  );
  const turn = await runTurn(invokeSubject, scenario, assembled.prompt, first, tools);
  const selection = scoreToolSelection(scenario, turn.calls);

  const answer = turn.answer;
  const guardrails = scoreAnswerGuardrails(scenario, answer, turn.calls);
  const judgeMessages = buildJudgeMessages(buildJudgeInput(scenario, turn.calls, answer, turn.results));
  // Samples are independent, so they run together. The median still decides,
  // and a malformed sample keeps its number in the failure text.
  const judged = await Promise.all(
    Array.from({ length: judgeSamples }, async (_, index): Promise<{ verdict?: Omit<JudgeVerdict, "score">; failure?: string }> => {
      const sample = index + 1;
      const messages = mode === "mock"
        ? [
            judgeMessages[0],
            {
              role: "user" as const,
              content: `${judgeMessages[1].content as string}\nMOCK:reply=${mockVerdict(scenario)}`,
            },
          ]
        : judgeMessages;
      try {
        const text = (await invokeJudge(config.judgeModel, messages, { api_key: config.judgeKey, temperature: 0 }, [])).text ?? "";
        return { verdict: parseJudgeVerdict(text) };
      } catch (error) {
        return { failure: `judge sample ${sample}: ${(error as Error).message}` };
      }
    }),
  );
  const verdicts = judged.flatMap((entry) => entry.verdict ? [entry.verdict] : []);
  const judgeFailures = judged.flatMap((entry) => entry.failure ? [entry.failure] : []);

  const scoring = evaluateJudgeSamples(scenario, verdicts, { minScore: minJudgeScore, floor: judgeFloor });
  const verdict: JudgeVerdict | null = verdicts.length > 0
    ? {
        criteria: verdicts[0].criteria,
        hard_failures_observed: [...new Set(verdicts.flatMap((sample) => sample.hard_failures_observed))],
        answer_makes_sense: verdicts.filter((sample) => sample.answer_makes_sense).length * 2 > verdicts.length,
        summary: verdicts[0].summary,
        score: scoring.score,
      }
    : null;

  const failures = [...selection.reasons, ...guardrails.reasons, ...scoring.failures, ...judgeFailures];
  const warnings = [...scoring.warnings];
  if (turn.capped) {
    failures.push(`turn did not converge within ${MAX_ROUNDS} model rounds; the follow-up answer is incomplete by construction`);
  }
  return {
    scenario: scenario.id,
    title: scenario.title,
    request: scenario.request,
    provider: config.provider,
    model: config.model,
    judgeModel: config.judgeModel,
    toolCalls: turn.calls,
    rounds: turn.rounds,
    capped: turn.capped,
    answer,
    selection,
    guardrails,
    judge: verdict,
    judgeSamples: scoring.samples,
    pass: failures.length === 0,
    failures,
    warnings,
  };
}

/** Earlier turns, replayed so a follow-up request has the history it assumes. */
function priorMessages(scenario: (typeof PROMPT_SCENARIOS)[number]): InvokeMessage[] {
  return scenario.prior.map((turn) => {
    if (turn.role === "assistant") {
      return turn.tool_calls.length === 0
        ? { role: "assistant", content: turn.content }
        : {
            role: "assistant",
            content: turn.content,
            tool_calls: turn.tool_calls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          };
    }
    if (turn.role === "tool") {
      return { role: "tool", tool_call_id: turn.tool_call_id ?? "", content: turn.content };
    }
    return { role: "user", content: turn.content };
  });
}

/** In mock mode the request carries a directive so the mock emits the expected
 *  call; a live run sends the scenario request unchanged. */
function selectionPrompt(scenario: (typeof PROMPT_SCENARIOS)[number]): string {
  if (mode !== "mock") return scenario.request;
  // The mock emits one call, so a scenario that requires several tools cannot
  // be self-tested this way; `activeScenarios` skips those. A proxied scenario
  // exercises invoke_tool itself, carrying the target name in its arguments.
  const tool = scenario.expect.proxiedTool ? "invoke_tool" : scenario.expect.tools[0];
  const args = JSON.stringify(scenario.expect.validArgs ?? {});
  return `${scenario.request}\nMOCK:tool=${tool}:${args}`;
}

type InvokeFn = NonNullable<ModelProvider["invoke"]>;

interface TurnResult {
  calls: ObservedToolCall[];
  /** Results served to the model, in call order. */
  results: Array<{ name: string; content: string }>;
  answer: string;
  rounds: number;
  /** True when the model was still calling tools when the round budget ran out. */
  capped: boolean;
}

/**
 * Runs the turn the way the agent does: model -> tool results -> model, bounded
 * to `MAX_ROUNDS`.
 *
 * Two things this fixes compared with a single round. The documented flows are
 * multi-step (check memory before saving, list before loading), so scoring only
 * the first call would fail correct behaviour. And a model that keeps calling
 * tools would otherwise be recorded as having produced an empty answer.
 */
async function runTurn(
  invoke: InvokeFn,
  scenario: (typeof PROMPT_SCENARIOS)[number],
  systemPrompt: string,
  first: InvokeResult,
  tools: OpenAITool[],
): Promise<TurnResult> {
  if (mode === "mock") {
    return {
      calls: first.tool_calls.map((call) => ({ name: call.name, arguments: call.arguments })),
      results: [],
      answer: `Saved. The tool confirmed key "${scenario.expect.validArgs?.key ?? "n/a"}" without interruption.`,
      rounds: 1,
      capped: false,
    };
  }

  const calls: ObservedToolCall[] = [];
  const results: Array<{ name: string; content: string }> = [];
  const cursors = new Map<string, number>();
  // The declared fixture answers the expected call once. Serving it to every
  // repeat would tell the model that an unrelated range, query, or target
  // returned the same content, which is a transcript no real tool produces.
  const servedFixture = new Set<string>();
  const messages: InvokeMessage[] = [
    ...priorMessages(scenario),
    { role: "user", content: scenario.request },
  ];
  let pending = first;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const call of pending.tool_calls) {
      calls.push({ name: call.name, arguments: call.arguments });
    }
    if (pending.tool_calls.length === 0) {
      return { calls, results, answer: pending.text ?? "", rounds: round, capped: false };
    }
    messages.push({
      role: "assistant",
      content: pending.text ?? "",
      tool_calls: pending.tool_calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    });
    for (const call of pending.tool_calls) {
      const content = resultFor(scenario, call, cursors, servedFixture);
      results.push({ name: typeof call.arguments.name === "string" ? `${call.name}:${call.arguments.name}` : call.name, content });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    // The system prompt is re-sent so the answer is produced under the same
    // instructions the selection was made under.
    pending = await invoke(
      config.model,
      [{ role: "system", content: systemPrompt }, ...messages],
      { api_key: config.key, temperature: 0 },
      tools,
    );
  }

  return {
    calls,
    results,
    answer: pending.text ?? "",
    rounds: MAX_ROUNDS,
    // Still calling tools after the budget: the turn never converged. Reported
    // separately so it is not mistaken for a bad answer.
    capped: pending.tool_calls.length > 0 || (pending.text ?? "") === "",
  };
}

function resultFor(
  scenario: (typeof PROMPT_SCENARIOS)[number],
  call: { name: string; arguments: Record<string, unknown> },
  cursors: Map<string, number>,
  servedFixture: Set<string>,
): string {
  // A proxied call must still receive the proxied tool's result, or the model
  // sees a stub and the judge grades a conversation that could not happen.
  const proxied = call.name === "invoke_tool" && typeof call.arguments.name === "string"
    ? call.arguments.name
    : null;
  const target = proxied ?? call.name;

  // Scripted sequences carry a failure the model has to recover from.
  const sequence = scenario.expect.toolResultSequence[target];
  if (sequence && sequence.length > 0) {
    const index = cursors.get(target) ?? 0;
    cursors.set(target, index + 1);
    return sequence[Math.min(index, sequence.length - 1)];
  }

  const declared = scenario.expect.toolResults[target] ?? scenario.expect.toolResults[call.name];
  if (declared) return declared;
  // The declared fixture is the expected outcome: the target of a proxied call
  // as much as a directly bound tool. Only the first call receives it; a second
  // call with different arguments is a different request and gets a clearly
  // synthetic result instead of a contradictory duplicate.
  if (scenario.expect.tools.includes(target) || scenario.expect.proxiedTool === target) {
    if (!servedFixture.has(target)) {
      servedFixture.add(target);
      return scenario.expect.toolResultFixture;
    }
    return GENERIC_TOOL_RESULT;
  }
  return GENERIC_TOOL_RESULT;
}

function writeReport(list: readonly ScenarioOutcome[]): void {
  const summary = aggregateOutcomes(list);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify({
      mode,
      provider: config.provider,
      model: config.model,
      judgeModel: config.judgeModel,
      minJudgeScore,
      generatedAt: new Date().toISOString(),
      summary,
      outcomes: list,
    }, null, 2),
    "utf8",
  );

  const lines = [
    `# Prompt behaviour report (${mode === "mock" ? "harness self-test, not a quality signal" : `${config.provider}/${config.model}`})`,
    "",
    `Tool selection accuracy: **${(summary.toolSelectionAccuracy * 100).toFixed(0)}%** of ${summary.total}`,
    `Mean judge score: **${summary.meanJudgeScore.toFixed(2)}** (target ${minJudgeScore.toFixed(2)}, floor ${judgeFloor.toFixed(2)}, ${judgeSamples} samples, median per scenario)`,
    "",
    "| Scenario | Selection | Judge | Result | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...list.map((outcome) => {
      // A criterion at or below 2 is a real observation even when the scenario
      // passes on the median; keep it visible instead of losing it.
      const flagged = (outcome.judge?.criteria ?? [])
        .filter((criterion) => criterion.score <= 2)
        .map((criterion) => `flagged: ${criterion.id}=${criterion.score}`);
      const notes = [...outcome.failures, ...outcome.warnings, ...flagged];
      return `| \`${outcome.scenario}\` | ${outcome.selection.pass ? "pass" : "fail"} | `
        + `${outcome.judge ? outcome.judge.score.toFixed(2) : "n/a"} | ${outcome.pass ? "pass" : "FAIL"} | `
        + `${notes.join("<br>")} |`;
    }),
    "",
    `Each turn is capped at ${MAX_ROUNDS} model rounds; selection is scored across the whole turn.`,
    "A scenario fails on a wrong selection, a judge hard failure, or a median below the floor.",
    "A median below the target is reported as a warning so a trend stays visible without failing the run.",
  ];
  const markdown = lines.join("\n");
  writeFileSync(join(reportDir, "report.md"), markdown, "utf8");
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      writeFileSync(stepSummary, `${markdown}\n`, { flag: "a" });
    } catch {
      /* the summary file is best effort */
    }
  }
}

afterAll(() => {
  if (runnable && outcomes.length > 0) writeReport(outcomes);
});

/**
 * Runs every scenario through the pool, indexing results by catalogue position
 * so the report keeps a stable order. A provider failure becomes a failed
 * scenario instead of losing the whole run's evidence.
 */
async function evaluateAll(): Promise<ScenarioOutcome[]> {
  const results = new Array<ScenarioOutcome | undefined>(activeScenarios.length);
  await mapPool(activeScenarios, concurrency, async (scenario, index) => {
    const startedAt = Date.now();
    try {
      results[index] = await evaluate(scenario);
    } catch (error) {
      const message = (error as Error).message;
      results[index] = {
        scenario: scenario.id,
        title: scenario.title,
        request: scenario.request,
        provider: config.provider,
        model: config.model,
        judgeModel: config.judgeModel,
        toolCalls: [],
        rounds: 0,
        capped: false,
        answer: "",
        selection: { pass: false, reasons: [] },
        guardrails: { pass: false, reasons: [] },
        judge: null,
        judgeSamples: [],
        pass: false,
        failures: [`evaluation failed: ${message}`],
        warnings: [],
        error: message,
      };
    }
    const outcome = results[index]!;
    // A run of this length needs visible progress; the CI log streams these.
    console.log(
      `[prompt-eval] ${outcome.pass ? "pass" : "FAIL"} ${scenario.id} ` +
        `(${Math.round((Date.now() - startedAt) / 1000)}s, ${outcome.rounds} round(s))`,
    );
  });
  return results.filter((outcome): outcome is ScenarioOutcome => outcome !== undefined);
}

describe.skipIf(!runnable)("live prompt behaviour", () => {
  it("selects the right tools and produces defensible answers", async () => {
    const results = await evaluateAll();
    outcomes.push(...results);

    const failures = results
      .filter((outcome) => !outcome.pass)
      .map(
        (outcome) => `${outcome.scenario} failed:\n- ${outcome.failures.join("\n- ")}\n` +
          `observed calls: ${JSON.stringify(outcome.toolCalls)}\nanswer: ${outcome.answer.slice(0, 400)}`,
      );
    expect(failures, "scenario failures").toEqual([]);

    const summary = aggregateOutcomes(results);
    expect(summary.total).toBe(activeScenarios.length);
    expect(summary.failed, JSON.stringify(summary.failures)).toBe(0);
    expect(summary.toolSelectionAccuracy).toBe(1);
    // The suite-level signal: per-scenario medians may wobble around the
    // target, but the run as a whole has to clear it.
    expect(
      summary.meanJudgeScore,
      `suite mean judge score ${summary.meanJudgeScore.toFixed(2)} is below the ${minJudgeScore.toFixed(2)} target`,
    ).toBeGreaterThanOrEqual(minJudgeScore);
  }, 25 * 60_000);
});
