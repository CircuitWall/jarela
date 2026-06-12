// Helpers that mask LangChain → InvokeMessage[] payloads against the
// current MaskRunContext. Returns the same shape with sensitive values
// swapped for «SECRET:...» placeholders, and records per-payload
// summaries on the run context for later UI surfacing.

import type { InvokeMessage, ContentPart, OpenAITool } from "@/lib/tools/types";
import type { RedactionSummary } from "./mask";
import { getMaskRunContext, recordSummary } from "./context";

function mergeSummaries(...lists: RedactionSummary[]): RedactionSummary {
  const totals = new Map<string, number>();
  for (const s of lists) {
    for (const e of s) totals.set(e.type_hint, (totals.get(e.type_hint) ?? 0) + e.count);
  }
  return Array.from(totals.entries()).map(([type_hint, count]) => ({ type_hint, count }));
}

function maskContent(content: string | ContentPart[]): {
  content: string | ContentPart[];
  summary: RedactionSummary;
} {
  const run = getMaskRunContext();
  if (!run) return { content, summary: [] };
  if (typeof content === "string") {
    const r = run.ctx.maskText(content);
    return { content: r.text, summary: r.summary };
  }
  const summaries: RedactionSummary[] = [];
  const parts: ContentPart[] = content.map((p) => {
    if (p.type === "text") {
      const r = run.ctx.maskText(p.text);
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
function maskJsonArgs(jsonStr: string): { args: string; summary: RedactionSummary } {
  const run = getMaskRunContext();
  if (!run) return { args: jsonStr, summary: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const r = run.ctx.maskText(jsonStr);
    return { args: r.text, summary: r.summary };
  }
  const r = run.ctx.maskJson(parsed);
  return { args: r.text, summary: r.summary };
}

// Walk an InvokeMessage[] payload and mask sensitive content in place.
// Records a per-message summary keyed by message index + role so the UI
// later can attribute "what was held back" to the right bubble.
export function maskInvokeMessages(messages: InvokeMessage[]): InvokeMessage[] {
  const run = getMaskRunContext();
  if (!run) return messages;
  return messages.map((m, i) => {
    const masked = { ...m };
    const summaries: RedactionSummary[] = [];

    const c = maskContent(m.content);
    masked.content = c.content;
    summaries.push(c.summary);

    if (m.tool_calls?.length) {
      masked.tool_calls = m.tool_calls.map((tc) => {
        const a = maskJsonArgs(tc.function.arguments);
        summaries.push(a.summary);
        return {
          ...tc,
          function: { ...tc.function, arguments: a.args },
        };
      });
    }

    const merged = mergeSummaries(...summaries);
    if (merged.length > 0) {
      recordSummary(`msg:${i}:${m.role}`, merged);
    }
    return masked;
  });
}

// Tool definitions passed to the provider include schema descriptions
// the model reads — those don't contain secrets. We don't mask
// OpenAITool[]; pass through as-is.
export function passthroughTools(tools: OpenAITool[]): OpenAITool[] {
  return tools;
}
