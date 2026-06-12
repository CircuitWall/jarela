// MaskContext propagation. A single context lives for the duration of one
// thread-run (one user-turn that may produce multiple LLM calls and tool
// invocations). It's stashed in AsyncLocalStorage so any code in the
// async tree — JarelaChatModel, tool wrappers, the agent stream — can
// reach it without threading the value through every signature.

import { AsyncLocalStorage } from "node:async_hooks";
import { createMaskContext, type MaskContext, type RedactionSummary } from "./mask";
import { loadRedactionConfig } from "./patterns";
import { isRedactionEnabled } from "@/lib/stores/app-settings";

export interface MaskRunContext {
  ctx: MaskContext;
  /** Per-payload summaries accumulated across the run. Keyed by an opaque
   * string the caller controls (e.g. "user", "tool:<id>:input", "tool:<id>:output").
   * Useful for surfacing what was held back per payload in the UI. */
  summaries: Map<string, RedactionSummary>;
  /** Combined summary across all payloads in this run. */
  totalSummary(): RedactionSummary;
}

const als = new AsyncLocalStorage<MaskRunContext>();

export function getMaskRunContext(): MaskRunContext | undefined {
  return als.getStore();
}

export function getCurrentMaskContext(): MaskContext | undefined {
  return als.getStore()?.ctx;
}

// Run `fn` with a fresh MaskRunContext. If redaction is disabled at the
// settings layer, the context is still created but the underlying
// MaskContext is a no-op — keeps the call sites uniform.
export function withMaskRun<T>(fn: () => T): T {
  if (!isRedactionEnabled()) {
    return als.run(makeNoopRunContext(), fn);
  }
  const config = loadRedactionConfig();
  const ctx = createMaskContext(config);
  const summaries = new Map<string, RedactionSummary>();
  const run: MaskRunContext = {
    ctx,
    summaries,
    totalSummary() {
      const totals = new Map<string, number>();
      for (const summary of summaries.values()) {
        for (const e of summary) {
          totals.set(e.type_hint, (totals.get(e.type_hint) ?? 0) + e.count);
        }
      }
      return Array.from(totals.entries()).map(([type_hint, count]) => ({ type_hint, count }));
    },
  };
  return als.run(run, fn);
}

function makeNoopRunContext(): MaskRunContext {
  const summaries = new Map<string, RedactionSummary>();
  const ctx: MaskContext = {
    maskText: (text) => ({ text, summary: [] }),
    maskJson: (value) => ({ text: JSON.stringify(value), summary: [] }),
    rehydrate: (text) => text,
    hasMaskedValues: () => false,
  };
  return {
    ctx,
    summaries,
    totalSummary: () => [],
  };
}

// Record a per-payload summary against the current run, if any. No-op
// outside a run.
export function recordSummary(key: string, summary: RedactionSummary): void {
  if (summary.length === 0) return;
  const run = als.getStore();
  if (!run) return;
  run.summaries.set(key, summary);
}
