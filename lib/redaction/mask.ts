// Masker + rehydrator. A MaskContext is a thread-scoped value:value⇆token
// map shared across all outbound payloads in one thread run, so the LLM
// sees a stable «SECRET:<id> type=<hint>» for the same source value
// across successive turns.
//
// Rehydration scans for the placeholder syntax and substitutes the
// original value back. This must run on:
//   * assistant text streamed to the UI
//   * tool-call arguments before the tool dispatcher invokes the tool
// Missing one of those paths leaks placeholders to users / breaks tools.

import { detectMatches, scanJson, type Match } from "./detect";
import type { RedactionConfig } from "./patterns";

export interface RedactionSummaryEntry {
  type_hint: string;
  count: number;
}
export type RedactionSummary = RedactionSummaryEntry[];

export interface MaskResult {
  text: string;
  summary: RedactionSummary;
}

export interface MaskContext {
  /** Mask sensitive content in a raw string. */
  maskText(text: string): MaskResult;
  /** Mask sensitive content in a JSON-shaped value (skips field_name_allowlist keys). Returns a JSON string. */
  maskJson(value: unknown): MaskResult;
  /** Replace «SECRET:<id> ...» placeholders with their original values. */
  rehydrate(text: string): string;
  /** True iff at least one value has been masked in this context. */
  hasMaskedValues(): boolean;
}

const PLACEHOLDER_RE = /«SECRET:([a-z0-9]+) type=([a-z0-9_]+)»/g;

export function createMaskContext(config: RedactionConfig): MaskContext {
  // value → token id; same value gets same id within this context, so
  // placeholders are stable and the model can refer back to "the same
  // secret" across turns.
  const valueToId = new Map<string, string>();
  const idToValue = new Map<string, string>();
  let counter = 0;

  function mintId(): string {
    counter += 1;
    // base36 keeps placeholders compact; counter monotonic per context.
    return counter.toString(36);
  }

  function tokenForValue(value: string, typeHint: string): string {
    let id = valueToId.get(value);
    if (id === undefined) {
      id = mintId();
      valueToId.set(value, id);
      idToValue.set(id, value);
    }
    return `«SECRET:${id} type=${typeHint}»`;
  }

  function applyMatches(text: string, matches: Match[]): MaskResult {
    if (matches.length === 0) return { text, summary: [] };
    const sorted = matches.slice().sort((a, b) => a.start - b.start);
    const counts = new Map<string, number>();
    const out: string[] = [];
    let i = 0;
    for (const m of sorted) {
      if (m.start < i) continue; // safety against unsorted overlap
      out.push(text.slice(i, m.start));
      out.push(tokenForValue(m.value, m.type_hint));
      counts.set(m.type_hint, (counts.get(m.type_hint) ?? 0) + 1);
      i = m.end;
    }
    out.push(text.slice(i));
    const summary: RedactionSummary = Array.from(counts.entries()).map(
      ([type_hint, count]) => ({ type_hint, count }),
    );
    return { text: out.join(""), summary };
  }

  return {
    maskText(text: string): MaskResult {
      const matches = detectMatches(text, config);
      return applyMatches(text, matches);
    },

    maskJson(value: unknown): MaskResult {
      const { text, matches } = scanJson(value, config);
      return applyMatches(text, matches);
    },

    rehydrate(text: string): string {
      if (idToValue.size === 0) return text;
      return text.replace(PLACEHOLDER_RE, (whole, id: string) => {
        const original = idToValue.get(id);
        return original ?? whole;
      });
    },

    hasMaskedValues(): boolean {
      return idToValue.size > 0;
    },
  };
}
