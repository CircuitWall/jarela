// Helpers that mask LangChain → InvokeMessage[] payloads against the
// current MaskRunContext. Returns the same shape with sensitive values
// swapped for «SECRET:...» placeholders, and records per-payload
// summaries on the run context for later UI surfacing.

import type { InvokeMessage, ContentPart } from "@/lib/tools/runtime/types";
import type { MaskContext, RedactionSummary } from "./mask";
import { getMaskRunContext, recordSummary } from "./context";

function mergeSummaries(...lists: RedactionSummary[]): RedactionSummary {
  const totals = new Map<string, number>();
  for (const s of lists) {
    for (const e of s) totals.set(e.type_hint, (totals.get(e.type_hint) ?? 0) + e.count);
  }
  return Array.from(totals.entries()).map(([type_hint, count]) => ({ type_hint, count }));
}

export function maskContentWith(ctx: MaskContext, content: string | ContentPart[]): {
  content: string | ContentPart[];
  summary: RedactionSummary;
} {
  if (typeof content === "string") {
    const r = ctx.maskText(content);
    return { content: r.text, summary: r.summary };
  }
  const summaries: RedactionSummary[] = [];
  const parts: ContentPart[] = content.map((p) => {
    if (p.type === "text") {
      const r = ctx.maskText(p.text);
      summaries.push(r.summary);
      return { ...p, text: r.text };
    }
    return p;
  });
  return { content: parts, summary: mergeSummaries(...summaries) };
}

// Mask a JSON-stringified tool call argument. The args field is the
// model's request to invoke a tool — we mask before sending so the
// provider doesn't see secrets the model picked up from prior tool
// outputs and is now passing forward.
function maskJsonArgs(ctx: MaskContext, jsonStr: string): { args: string; summary: RedactionSummary } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const r = ctx.maskText(jsonStr);
    return { args: r.text, summary: r.summary };
  }
  const r = ctx.maskJson(parsed);
  return { args: r.text, summary: r.summary };
}

function maskMessageWith(ctx: MaskContext, m: InvokeMessage): { message: InvokeMessage; summary: RedactionSummary } {
  const masked = { ...m };
  const summaries: RedactionSummary[] = [];

  const c = maskContentWith(ctx, m.content);
  masked.content = c.content;
  summaries.push(c.summary);

  if (m.tool_calls?.length) {
    masked.tool_calls = m.tool_calls.map((tc) => {
      const a = maskJsonArgs(ctx, tc.function.arguments);
      summaries.push(a.summary);
      return {
        ...tc,
        function: { ...tc.function, arguments: a.args },
      };
    });
  }
  return { message: masked, summary: mergeSummaries(...summaries) };
}

// Mask an InvokeMessage[] payload against an explicit MaskContext without
// recording run summaries. Used by background model calls.
export function maskInvokeMessagesWith(ctx: MaskContext, messages: InvokeMessage[]): InvokeMessage[] {
  return messages.map((m) => maskMessageWith(ctx, m).message);
}

// Walk an InvokeMessage[] payload and mask sensitive content in place.
// Records a per-message summary keyed by message index + role so the UI
// later can attribute "what was held back" to the right bubble.
export function maskInvokeMessages(messages: InvokeMessage[]): InvokeMessage[] {
  const run = getMaskRunContext();
  if (!run) return messages;
  return messages.map((m, i) => {
    const { message, summary } = maskMessageWith(run.ctx, m);
    if (summary.length > 0) {
      recordSummary(`msg:${i}:${m.role}`, summary);
    }
    return message;
  });
}
