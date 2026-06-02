// Validator hit-rate telemetry.
//
// The output validator (ADR-0037) detects four shapes of fabrication:
// claim_without_tool / citation_unregistered_tool / citation_uncalled_tool /
// summary_without_action. The bloat audit flagged it as Tier-2 ("instrument
// hit rate, decide on simplification or removal"). This module is the
// instrument: every validator call records its outcome (ok / which kind
// fired) into an in-memory ring buffer + emits a structured console line.
//
// Design constraints:
//   - Zero behaviour change to the validator itself. This is a wrapper.
//   - Bounded memory: ring of 500 entries, overflow drops the oldest.
//   - No DB writes — telemetry is process-local and resets on restart.
//     The decision criterion ("hit rate over the last N runs") is meant
//     to be observed live, not from historical data.
//   - The JARELA_DISABLE_OUTPUT_VALIDATOR env flag short-circuits the
//     validator to `ok=true` — operator escape hatch + a way to A/B test
//     "what happens if we delete this thing" without actually deleting.
//
// See ADR-0057.

import { validateAssistantOutput } from "./validator";
import type { ValidationResult, ValidationKind } from "./types";

/** Stage at which the validator was invoked. Helps interpret hit rates. */
export type ValidatorStage = "stall_retry_check" | "footer_check";

export interface ValidatorTelemetryEntry {
  stage: ValidatorStage;
  kind: ValidationKind | "ok";
  /** Truncated evidence string (max 200 chars) when not ok. */
  evidence?: string;
  /** Tools called this turn — empty array on fabrication-without-tool cases. */
  tools_called: number;
  ts: number;
}

const RING_CAPACITY = 500;
const ring: ValidatorTelemetryEntry[] = [];

function isValidatorDisabled(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  return process.env.JARELA_DISABLE_OUTPUT_VALIDATOR === "1";
}

function recordValidatorResult(
  stage: ValidatorStage,
  result: ValidationResult,
  toolsCalled: number,
): void {
  const entry: ValidatorTelemetryEntry = result.ok
    ? { stage, kind: "ok", tools_called: toolsCalled, ts: Date.now() }
    : {
        stage,
        kind: result.kind,
        evidence: result.evidence.slice(0, 200),
        tools_called: toolsCalled,
        ts: Date.now(),
      };
  ring.push(entry);
  if (ring.length > RING_CAPACITY) {
    ring.splice(0, ring.length - RING_CAPACITY);
  }
  // Console form is grep-friendly; in real ops we'd ship to a metrics
  // backend, but the runtime is a single local Node process — console
  // is sufficient for the "decide if we can delete this" question.
  if (!result.ok) {
    console.info(
      `[validator] stage=${stage} kind=${result.kind} tools_called=${toolsCalled} evidence=${(result.evidence ?? "").slice(0, 120)}`,
    );
  }
}

/**
 * Replacement for direct `validateAssistantOutput` calls. Identical inputs
 * + return value, but records the outcome in the ring buffer first. When
 * `JARELA_DISABLE_OUTPUT_VALIDATOR=1` the validator is short-circuited to
 * `{ok:true}` without invoking the underlying detectors — used to A/B test
 * removal before deleting the validator code.
 */
export function validateWithTelemetry(
  stage: ValidatorStage,
  text: string,
  toolCalls: readonly string[],
  allowedTools: readonly string[],
): ValidationResult {
  if (isValidatorDisabled()) {
    // Record the no-op so we can compare disabled-period hit rates against
    // enabled-period rates side-by-side in the same buffer.
    const entry: ValidatorTelemetryEntry = {
      stage,
      kind: "ok",
      tools_called: toolCalls.length,
      ts: Date.now(),
    };
    ring.push(entry);
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
    return { ok: true };
  }
  const result = validateAssistantOutput(text, toolCalls, allowedTools);
  recordValidatorResult(stage, result, toolCalls.length);
  return result;
}

export interface ValidatorStats {
  /** Total entries currently in the ring (≤ RING_CAPACITY). */
  total: number;
  /** Count where ok=true. */
  ok: number;
  /** Per-kind count of fired checks. */
  by_kind: Record<ValidationKind, number>;
  /** Per-stage count of fires (ok + non-ok). */
  by_stage: Record<ValidatorStage, number>;
  /** Total non-ok / total — the "hit rate" the audit decision turns on. */
  hit_rate: number;
  /** True when JARELA_DISABLE_OUTPUT_VALIDATOR=1 is currently set. */
  disabled: boolean;
}

export function getValidatorStats(): ValidatorStats {
  const total = ring.length;
  let ok = 0;
  const byKind: Record<ValidationKind, number> = {
    claim_without_tool: 0,
    citation_unregistered_tool: 0,
    citation_uncalled_tool: 0,
    summary_without_action: 0,
  };
  const byStage: Record<ValidatorStage, number> = {
    stall_retry_check: 0,
    footer_check: 0,
  };
  for (const e of ring) {
    byStage[e.stage] += 1;
    if (e.kind === "ok") ok += 1;
    else byKind[e.kind] += 1;
  }
  return {
    total,
    ok,
    by_kind: byKind,
    by_stage: byStage,
    hit_rate: total === 0 ? 0 : (total - ok) / total,
    disabled: isValidatorDisabled(),
  };
}

/** Most recent N entries from the ring buffer. */
export function recentValidatorEntries(limit?: number): ValidatorTelemetryEntry[] {
  if (!limit || limit >= ring.length) return ring.slice();
  return ring.slice(-limit);
}

/** Test-only: drop accumulated entries between cases. */
export function _resetValidatorTelemetry(): void {
  ring.length = 0;
}
