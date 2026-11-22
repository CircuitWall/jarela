/**
 * Shared shapes for the prompt-behaviour suite.
 *
 * A scenario is a single, checkable claim: "for this request, with these tools
 * available, the correct behaviour is this tool call plus an answer that
 * survives a rubric." The deterministic tier checks the claim against the
 * assembled prompt; the live tier checks it against a real model.
 *
 * See docs/PROMPT_EVALUATION.md.
 */
import { z } from "zod";

export const judgeCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  /** Relative weight; the aggregate normalises by the sum. */
  weight: z.number().positive(),
  description: z.string().min(1),
});

export const promptScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  /** The mistake class this scenario exists to catch. */
  risk: z.string().min(1),
  /** Tools pinned onto the agent's configured list, on top of the basic defaults. */
  agentTools: z.array(z.string()).default([]),
  /**
   * When set, only these tools are bound with definitions; every other enabled
   * tool stays reachable through invoke_tool as `proxy_only`. Reproduces an
   * agent whose surface is narrowed by a pin list or a provider tool cap.
   */
  bindOnly: z.array(z.string()).default([]),
  /**
   * Earlier turns this request builds on. A follow-up ("which date did they
   * promise?") is only realistic if the conversation already has the result it
   * refers to; without this the test would have to spell the mechanic out in
   * the request, which is exactly what makes tool selection trivial.
   */
  prior: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "tool"]),
        content: z.string(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              arguments: z.record(z.string(), z.unknown()),
            }),
          )
          .default([]),
        tool_call_id: z.string().optional(),
      }),
    )
    .default([]),
  request: z.string().min(1),
  expect: z.object({
    /** At least one of these must be called when `requireToolCall` is true. */
    tools: z.array(z.string()).default([]),
    /** Any call to one of these fails the run even if the expected tool also ran. */
    forbidden: z.array(z.string()).default([]),
    requireToolCall: z.boolean(),
    /** Require every name in `tools`, not just one of them. */
    requireAll: z.boolean().default(false),
    /** When set, invoke_tool must target exactly this tool. */
    proxiedTool: z.string().optional(),
    /** Fail when the same tool is called twice with identical arguments. */
    noIdenticalRetries: z.boolean().default(true),
    /** Keys the matching call must carry. */
    argumentKeys: z.array(z.string()).default([]),
    /**
     * Values from the request that must never appear verbatim in the reply or
     * a tool argument, for example a pasted credential. Checked by code, so an
     * echoed secret fails the run regardless of the judge's weighted score.
     */
    mustNotEcho: z.array(z.string().min(4)).default([]),
    /**
     * JSON-encoded results for tools the model may legitimately call first, so
     * a bounded turn can complete. The documented flows are multi-step (search
     * before saving, list before loading), so a single round only sees the
     * intermediate call.
     */
    toolResults: z.record(z.string(), z.string()).default({}),
    /**
     * Results consumed in call order for one tool, before `toolResults` and
     * `toolResultFixture` take over. The first entry is the failure a debug path
     * has to recover from, the second the repaired attempt.
     */
    toolResultSequence: z.record(z.string(), z.array(z.string()).min(1)).default({}),
    /**
     * A representative argument object. Omitted when the only valid values come
     * from a runtime-derived enum, where the check would test the fixture rather
     * than the tool contract.
     */
    validArgs: z.record(z.string(), z.unknown()).optional(),
    /**
     * JSON-encoded tool result the live tier feeds back after the observed call.
     * The live tier never executes tools, so this keeps the judged answer
     * grounded in declared evidence instead of invented output.
     */
    toolResultFixture: z.string().min(2),
  }),
  /**
   * Substrings the assembled system prompt must keep. These are the tripwires:
   * if wording that carries the decision is removed or reworded, the
   * deterministic tier fails before the behaviour can regress.
   */
  promptAnchors: z.array(z.string().min(8)).min(1),
  judge: z.object({
    criteria: z.array(judgeCriterionSchema).min(1),
    /** Observations that fail the run regardless of criterion scores. */
    hardFailures: z.array(z.string().min(4)).min(1),
  }),
});

export type PromptScenario = z.infer<typeof promptScenarioSchema>;
/** Authoring shape: defaulted fields may be omitted here. */
export type PromptScenarioInput = z.input<typeof promptScenarioSchema>;
export type JudgeCriterion = z.infer<typeof judgeCriterionSchema>;

export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Deterministic verdict on tool selection. */
export interface SelectionVerdict {
  pass: boolean;
  reasons: string[];
}

/** Deterministic verdict on answer-level rules code can check. */
export interface GuardrailVerdict {
  pass: boolean;
  reasons: string[];
}

export interface JudgeVerdict {
  criteria: Array<{ id: string; score: number; reason: string }>;
  hard_failures_observed: string[];
  answer_makes_sense: boolean;
  summary: string;
  /** Weighted 0..1 score derived from the criteria. */
  score: number;
}

export interface ScenarioOutcome {
  scenario: string;
  title: string;
  request: string;
  provider: string;
  model: string;
  judgeModel: string;
  toolCalls: ObservedToolCall[];
  /** Model rounds consumed before the turn produced an answer. */
  rounds: number;
  /** True when the round budget ran out before the turn converged. */
  capped: boolean;
  answer: string;
  selection: SelectionVerdict;
  /** Answer-level rules code checked before the judge saw the transcript. */
  guardrails: GuardrailVerdict;
  judge: JudgeVerdict | null;
  /** Per-sample judge scores; the median decides pass or fail. */
  judgeSamples: number[];
  pass: boolean;
  failures: string[];
  /** Below the target but above the floor: visible, not a failure. */
  warnings: string[];
  error?: string;
}
