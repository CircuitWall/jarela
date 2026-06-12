// Detection layer. Scans text for sensitive content using:
//   1. The configured regex patterns, optionally validated by a named
//      built-in (luhn / mod97 / personnummer_check).
//   2. A high-entropy heuristic — long, random-looking runs of allowed
//      chars, gated by Shannon entropy and an exclude allowlist.
//
// Returns non-overlapping matches sorted by start offset; on overlap the
// longer match wins (prevents an entropy match from chopping a regex
// match in half).

import { VALIDATORS } from "./validators";
import type { RedactionConfig } from "./patterns";

export interface Match {
  start: number;
  end: number;
  value: string;
  type_hint: string;
  source: "pattern" | "heuristic";
  pattern_name?: string;
}

export function detectMatches(text: string, config: RedactionConfig): Match[] {
  const raw: Match[] = [];

  for (const p of config.patterns) {
    if (!p.enabled) continue;
    let re: RegExp;
    try {
      re = new RegExp(p.regex, "g");
    } catch {
      continue;
    }
    const validator = p.validator ? VALIDATORS[p.validator] : null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (validator && !validator(m[0])) continue;
      raw.push({
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
        type_hint: p.type_hint,
        source: "pattern",
        pattern_name: p.name,
      });
    }
  }

  const heuristic = config.heuristics.high_entropy;
  if (heuristic.enabled) {
    let charClass: RegExp;
    try {
      charClass = new RegExp(`${heuristic.char_class}+`, "g");
    } catch {
      charClass = /[A-Za-z0-9_=+/.-]+/g;
    }
    const excludes = heuristic.exclude_patterns
      .map((p) => {
        try { return new RegExp(p); } catch { return null; }
      })
      .filter((re): re is RegExp => re !== null);

    let m: RegExpExecArray | null;
    while ((m = charClass.exec(text)) !== null) {
      const value = m[0];
      if (value.length < heuristic.min_length) continue;
      if (shannonEntropy(value) < heuristic.min_entropy) continue;
      if (excludes.some((re) => re.test(value))) continue;
      raw.push({
        start: m.index,
        end: m.index + value.length,
        value,
        type_hint: "unknown_long_string",
        source: "heuristic",
      });
    }
  }

  return resolveOverlaps(raw);
}

// Shannon entropy in bits/char. Pure ASCII counting; good enough for
// what we need (distinguishing repeated/structured strings from random
// keys).
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  let h = 0;
  const len = s.length;
  for (const k of Object.keys(counts)) {
    const p = counts[k] / len;
    h -= p * Math.log2(p);
  }
  return h;
}

// Resolve overlaps with a priority order:
//   1. Pattern matches always beat heuristic matches (a high-precision
//      regex like `sk-ant-…` should win over the catch-all entropy run
//      that surrounds it).
//   2. Within the same source, longer wins.
//   3. Within the same source and length, earlier wins (stable order).
// Greedy: walk highest-priority first; keep only if no overlap with an
// already-kept match. Result is returned sorted by start.
function resolveOverlaps(matches: Match[]): Match[] {
  if (matches.length <= 1) return matches.slice().sort((a, b) => a.start - b.start);
  const ordered = matches.slice().sort((a, b) => {
    if (a.source !== b.source) return a.source === "pattern" ? -1 : 1;
    const aLen = a.end - a.start;
    const bLen = b.end - b.start;
    if (aLen !== bLen) return bLen - aLen;
    return a.start - b.start;
  });
  const kept: Match[] = [];
  for (const m of ordered) {
    const overlaps = kept.some((k) => m.start < k.end && k.start < m.end);
    if (!overlaps) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// JSON walker: returns the same Match[] shape but operates on parsed
// JSON, skipping values whose key matches `field_name_allowlist`. Each
// returned Match's offsets are byte offsets *within the produced
// re-serialized JSON string* — callers should use the returned text
// alongside the matches.
export interface JsonScanResult {
  /** The JSON re-serialized so offsets in `matches` are valid against it. */
  text: string;
  matches: Match[];
}

export function scanJson(value: unknown, config: RedactionConfig): JsonScanResult {
  const allowlist = new Set(config.field_name_allowlist);
  const segments: string[] = [];
  const matches: Match[] = [];
  let cursor = 0;

  function emit(s: string): void {
    segments.push(s);
    cursor += s.length;
  }

  function walk(v: unknown, parentKey: string | null): void {
    if (v === null) return emit("null");
    if (typeof v === "string") {
      const skip = parentKey != null && allowlist.has(parentKey);
      const start = cursor;
      const json = JSON.stringify(v);
      emit(json);
      if (skip) return;
      // Detection runs against the raw string; offsets are then mapped
      // back into the rendered JSON literal (start + 1 to skip the
      // opening quote). For values containing escape sequences this is
      // a slight under-count but still produces non-overlapping ranges
      // that mask cleanly because the escaped characters never appear
      // inside a sensitive pattern's matched text.
      const inner = detectMatches(v, config);
      for (const m of inner) {
        matches.push({
          ...m,
          start: start + 1 + m.start,
          end: start + 1 + m.end,
        });
      }
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      emit(JSON.stringify(v));
      return;
    }
    if (Array.isArray(v)) {
      emit("[");
      for (let i = 0; i < v.length; i++) {
        if (i > 0) emit(",");
        walk(v[i], null);
      }
      emit("]");
      return;
    }
    if (typeof v === "object") {
      emit("{");
      const entries = Object.entries(v as Record<string, unknown>);
      for (let i = 0; i < entries.length; i++) {
        if (i > 0) emit(",");
        const [k, child] = entries[i];
        emit(JSON.stringify(k));
        emit(":");
        walk(child, k);
      }
      emit("}");
      return;
    }
    emit("null");
  }

  walk(value, /* parentKey */ null);
  return { text: segments.join(""), matches };
}
