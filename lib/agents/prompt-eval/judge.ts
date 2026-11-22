/**
 * LLM-as-judge for the live prompt-evaluation tier.
 *
 * The judge scores answer quality against a per-scenario rubric. Tool selection
 * is never delegated to the judge — `scoreToolSelection` decides that by code,
 * because a judge can be talked into a verdict but a declared expectation cannot.
 *
 * The prompt is registered in `lib/agents/prompt-registry.ts` so it is rendered
 * and reviewed with every other prompt Jarela sends.
 */
import { z } from "zod";
import type { InvokeMessage } from "@/lib/providers/types";
import type { JudgeVerdict, ObservedToolCall, PromptScenario } from "./types";

export const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge for a local AI agent. You score how well one transcript answers one user request. You are not the agent, you never continue the task, and you never assume work that the transcript does not show.

INPUT
The user message is one JSON object with these fields:
- request: the user's exact request.
- risky_behaviour: the mistake this scenario exists to catch.
- expected_tool_calls: tool names the agent was supposed to call.
- forbidden_tool_calls: tool names that indicate a wrong choice.
- observed_tool_calls: the tool calls the agent actually made, with their arguments.
- tool_results: the results the agent received this turn, in call order, as "<tool name> -> <result>". Treat them as the only evidence the agent had. They are synthetic harness fixtures, not real user data.
- observed_answer: the agent's final reply.
- criteria: [{ id, weight, description }] to score. Some are specific to this scenario; others are cross-cutting behaviours that apply to every scenario.
- hard_failures: observations that fail the run outright.

PROCEDURE
1. Read observed_tool_calls, tool_results and observed_answer. Judge only what the transcript shows; hidden reasoning is out of scope.
2. Score every criterion from 0 to 5:
   5 fully satisfied, 4 satisfied with a minor gap, 3 partly satisfied,
   2 mostly missing, 1 attempted but wrong, 0 not attempted or contradicted by the transcript.
   Judge the reply against its own evidence, not against what you would have written.
3. Score each id in criteria exactly once. Do not invent ids, merge criteria, or skip one.
4. Record a hard failure only when the transcript literally shows it, quoting the matching entry from hard_failures verbatim.
5. Set answer_makes_sense to false when the reply is off-topic, contradicts the transcript, or would mislead the user, even when no hard failure matched.
6. Ignore style preferences that the criteria do not ask for. A concise correct answer is not a gap.
7. Tool selection and argument shape are verified outside this rubric. Judge behaviour from the reply and the evidence it had; a correct tool call does not earn credit for a criterion the reply does not satisfy.

OUTPUT
Return exactly one JSON object and nothing else:
{"criteria":[{"id":"criterion-id","score":0,"reason":"one short sentence"}],"hard_failures_observed":[],"answer_makes_sense":true,"summary":"one sentence"}
Output rules:
- Every id from criteria appears exactly once in criteria.
- hard_failures_observed quotes entries from hard_failures verbatim, and is [] when none occurred.
- reasons are one short sentence each and cite the transcript, not the rubric.
- No markdown fences, no prose before or after the JSON.`;

const verdictSchema = z.object({
  criteria: z
    .array(z.object({ id: z.string(), score: z.number(), reason: z.string() }))
    .min(1),
  hard_failures_observed: z.array(z.string()),
  answer_makes_sense: z.boolean(),
  summary: z.string(),
});

export interface JudgeInput {
  request: string;
  risky_behaviour: string;
  expected_tool_calls: string[];
  forbidden_tool_calls: string[];
  observed_tool_calls: ObservedToolCall[];
  tool_results: string[];
  observed_answer: string;
  criteria: PromptScenario["judge"]["criteria"];
  hard_failures: string[];
}

export function buildJudgeInput(
  scenario: PromptScenario,
  calls: readonly ObservedToolCall[],
  answer: string,
  /** Results actually served to the model this turn, in call order. */
  toolResults: readonly { name: string; content: string }[] = [],
): JudgeInput {
  return {
    request: scenario.request,
    risky_behaviour: scenario.risk,
    expected_tool_calls: [...scenario.expect.tools],
    forbidden_tool_calls: [...scenario.expect.forbidden],
    observed_tool_calls: calls.map((call) => ({ name: call.name, arguments: call.arguments })),
    // Grading against a single declared fixture while the turn served several
    // results makes grounded claims look invented. Pass what the model saw.
    tool_results: toolResults.length > 0
      ? toolResults.map((result) => `${result.name} -> ${result.content}`)
      : [scenario.expect.toolResultFixture],
    observed_answer: answer,
    criteria: [...scenario.judge.criteria],
    hard_failures: [...scenario.judge.hardFailures],
  };
}

export function buildJudgeMessages(input: JudgeInput): InvokeMessage[] {
  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(input, null, 2) },
  ];
}

/**
 * Parses a judge reply. A malformed reply is an evaluation failure, not a pass:
 * silently treating unparseable output as approval would hide judge-prompt
 * regressions behind green CI.
 *
 * The returned value has no `score`; the weighted score is computed by
 * `scoreJudgeVerdict` so there is one authoritative calculation.
 */
export function parseJudgeVerdict(text: string): Omit<JudgeVerdict, "score"> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`judge reply contained no JSON object: ${truncate(text)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`judge reply was not valid JSON (${(error as Error).message}): ${truncate(text)}`);
  }
  const result = verdictSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`judge reply did not match the verdict shape: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data;
}

function truncate(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 200);
}
