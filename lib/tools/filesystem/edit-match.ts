// Shared str_replace matching engine for file_edit / file_multi_edit.
//
// The hot path (`locateOldString` with strategy "exact" on a file whose line
// endings already match `old_string`) is a plain indexOf loop — identical
// cost to the pre-existing behavior. Everything below that is a fallback
// that only runs once the hot path has already failed to find a unique
// match, so normal edits never pay for it.

export type EditStrategy = "exact" | "trim_trailing" | "normalize_whitespace";

// A `Transform` rewrites text for matching purposes while remembering, for
// every character it emits, the offset in the ORIGINAL text it came from.
// `toOriginal` has length `text.length + 1` — the extra trailing entry is a
// sentinel pointing just past the original text, so a match that runs to the
// end of the transformed string still maps to a valid raw end-offset.
interface Transform {
  text: string;
  toOriginal: number[];
}

function identityTransform(s: string): Transform {
  const toOriginal = new Array<number>(s.length + 1);
  for (let i = 0; i <= s.length; i++) toOriginal[i] = i;
  return { text: s, toOriginal };
}

// Collapses \r\n and lone \r to \n for matching purposes only. The raw file
// is never rewritten by this transform — callers slice the ORIGINAL text
// using the offsets it reports.
function normalizeEolTransform(s: string): Transform {
  const out: string[] = [];
  const toOriginal: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\r" && s[i + 1] === "\n") {
      out.push("\n");
      toOriginal.push(i);
      i += 2;
    } else if (s[i] === "\r") {
      out.push("\n");
      toOriginal.push(i);
      i += 1;
    } else {
      out.push(s[i]);
      toOriginal.push(i);
      i += 1;
    }
  }
  toOriginal.push(s.length);
  return { text: out.join(""), toOriginal };
}

// Drops trailing spaces/tabs at the end of every line. Newlines (and
// everything else) pass through verbatim.
function trimTrailingTransform(s: string): Transform {
  const out: string[] = [];
  const toOriginal: number[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    let lineEnd = i;
    while (lineEnd < n && s[lineEnd] !== "\n" && s[lineEnd] !== "\r") lineEnd++;
    let trimEnd = lineEnd;
    while (trimEnd > i && (s[trimEnd - 1] === " " || s[trimEnd - 1] === "\t")) trimEnd--;
    for (let k = i; k < trimEnd; k++) {
      out.push(s[k]);
      toOriginal.push(k);
    }
    i = lineEnd;
    while (i < n && (s[i] === "\n" || s[i] === "\r")) {
      out.push(s[i]);
      toOriginal.push(i);
      i++;
    }
  }
  toOriginal.push(n);
  return { text: out.join(""), toOriginal };
}

// Strips leading/trailing spaces/tabs per line and collapses internal runs
// of spaces/tabs to a single space. Newlines pass through verbatim so line
// structure (and diagnostics built on top of it) stays meaningful.
function normalizeWhitespaceTransform(s: string): Transform {
  const out: string[] = [];
  const toOriginal: number[] = [];
  const isHWs = (ch: string) => ch === " " || ch === "\t";
  let i = 0;
  const n = s.length;
  while (i < n) {
    let lineEnd = i;
    while (lineEnd < n && s[lineEnd] !== "\n" && s[lineEnd] !== "\r") lineEnd++;
    let k = i;
    while (k < lineEnd && isHWs(s[k])) k++; // drop leading run entirely
    while (k < lineEnd) {
      if (isHWs(s[k])) {
        let runEnd = k;
        while (runEnd < lineEnd && isHWs(s[runEnd])) runEnd++;
        if (runEnd < lineEnd) {
          // Internal run (more non-whitespace follows on this line) → single space.
          out.push(" ");
          toOriginal.push(k);
        } // else: trailing run — drop entirely.
        k = runEnd;
      } else {
        out.push(s[k]);
        toOriginal.push(k);
        k++;
      }
    }
    i = lineEnd;
    while (i < n && (s[i] === "\n" || s[i] === "\r")) {
      out.push(s[i]);
      toOriginal.push(i);
      i++;
    }
  }
  toOriginal.push(n);
  return { text: out.join(""), toOriginal };
}

function strategyTransform(strategy: EditStrategy): ((s: string) => Transform) | null {
  if (strategy === "trim_trailing") return trimTrailingTransform;
  if (strategy === "normalize_whitespace") return normalizeWhitespaceTransform;
  return null;
}

function composeTransforms(raw: string, fns: Array<(s: string) => Transform>): Transform {
  let current: Transform = identityTransform(raw);
  for (const fn of fns) {
    const next = fn(current.text);
    const composedMap = next.toOriginal.map((idx) => current.toOriginal[idx]);
    current = { text: next.text, toOriginal: composedMap };
  }
  return current;
}

export interface MatchRange {
  start: number;
  end: number;
}

function findAllExact(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    starts.push(idx);
    from = idx + needle.length;
  }
  return starts;
}

// Finds every occurrence of `oldString` inside `raw` after applying `fns` to
// both sides. Returned ranges are always in RAW coordinates — callers slice
// the original text, never the transformed one.
function findWithTransforms(raw: string, oldString: string, fns: Array<(s: string) => Transform>): MatchRange[] {
  const bufT = composeTransforms(raw, fns);
  const oldT = composeTransforms(oldString, fns);
  if (oldT.text.length === 0) return [];
  const starts = findAllExact(bufT.text, oldT.text);
  return starts.map((s) => ({
    start: bufT.toOriginal[s],
    end: bufT.toOriginal[s + oldT.text.length],
  }));
}

export interface EditAttempt {
  ranges: MatchRange[];
  usedStrategy: EditStrategy;
  crlfAdjusted: boolean;
}

// Tries, in order:
//   1. Plain exact indexOf — the hot path, zero transform overhead.
//   2. EOL-normalized exact match — recovers when old_string's line endings
//      (LF/CRLF) don't match the file's, regardless of requested strategy.
//   3. The requested fuzzy strategy (also EOL-normalized), only if a
//      non-"exact" strategy was requested and the above found nothing.
export function locateOldString(raw: string, oldString: string, requestedStrategy: EditStrategy): EditAttempt {
  const exact = findAllExact(raw, oldString).map((s) => ({ start: s, end: s + oldString.length }));
  if (exact.length > 0) return { ranges: exact, usedStrategy: "exact", crlfAdjusted: false };

  if (oldString.includes("\n") || oldString.includes("\r")) {
    const eolOnly = findWithTransforms(raw, oldString, [normalizeEolTransform]);
    if (eolOnly.length > 0) return { ranges: eolOnly, usedStrategy: "exact", crlfAdjusted: true };
  }

  if (requestedStrategy !== "exact") {
    const fn = strategyTransform(requestedStrategy);
    if (fn) {
      const withStrategy = findWithTransforms(raw, oldString, [normalizeEolTransform, fn]);
      if (withStrategy.length > 0) {
        return { ranges: withStrategy, usedStrategy: requestedStrategy, crlfAdjusted: true };
      }
    }
  }

  return { ranges: [], usedStrategy: requestedStrategy, crlfAdjusted: false };
}

export function dominantEol(raw: string): "\r\n" | "\n" | null {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") {
      if (raw[i - 1] === "\r") crlf++;
      else lf++;
    }
  }
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? "\r\n" : "\n";
}

// Conforms replacement text to the file's dominant line ending. Used only
// when the match itself required EOL normalization — plain exact matches
// never touch new_string, so ordinary edits are unaffected.
export function conformEol(text: string, eol: "\r\n" | "\n"): string {
  if (eol === "\n") return text.replace(/\r\n/g, "\n");
  return text.replace(/\r\n|\n/g, "\r\n");
}

export function lineNumberAt(raw: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < raw.length; i++) {
    if (raw[i] === "\n") line++;
  }
  return line;
}

// Bound the nearest-match scan so a pathological (very long) file can't turn
// a failed edit into an expensive diagnostic pass.
const DIAGNOSTIC_MAX_LINES = 20_000;

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length < 2) {
    if (s.length === 1) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return (2 * common) / (A.size + B.size);
}

export interface NotFoundDiagnostic {
  reason: "not_found";
  nearest_match: { line: number; similarity: number; snippet: string } | null;
  normalized_hint: string | null;
}

// Built when old_string couldn't be located at all (even after the EOL and
// strategy fallbacks). Two independent signals:
//  - nearest_match: the buffer line most textually similar to old_string's
//    first non-blank line, with ±3 lines of context.
//  - normalized_hint: whether a fuzzy strategy the caller DIDN'T request
//    would have found a unique match, so they know what to retry with.
export function buildNotFoundDiagnostic(raw: string, oldString: string): NotFoundDiagnostic {
  const bufLines = raw.split(/\r\n|\r|\n/);
  const anchorLine = oldString.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? oldString.trim();

  let nearest_match: NotFoundDiagnostic["nearest_match"] = null;
  if (bufLines.length <= DIAGNOSTIC_MAX_LINES && anchorLine.length > 0) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < bufLines.length; i++) {
      const score = diceSimilarity(anchorLine, bufLines[i].trim());
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1 && bestScore > 0.2) {
      const from = Math.max(0, bestIdx - 3);
      const to = Math.min(bufLines.length - 1, bestIdx + 3);
      const snippet = bufLines
        .slice(from, to + 1)
        .map((l, k) => `${from + k + 1}: ${l}`)
        .join("\n");
      nearest_match = { line: bestIdx + 1, similarity: Math.round(bestScore * 100) / 100, snippet };
    }
  }

  let normalized_hint: string | null = null;
  for (const strategy of ["trim_trailing", "normalize_whitespace"] as const) {
    const fn = strategyTransform(strategy);
    if (!fn) continue;
    const attempt = findWithTransforms(raw, oldString, [normalizeEolTransform, fn]);
    if (attempt.length === 1) {
      normalized_hint = `matches uniquely at line ${lineNumberAt(raw, attempt[0].start)} if strategy="${strategy}" is used`;
      break;
    }
  }

  return { reason: "not_found", nearest_match, normalized_hint };
}

export interface MultipleMatchesDiagnostic {
  reason: "multiple_matches";
  occurrences: number[];
}

export function buildMultipleMatchesDiagnostic(raw: string, ranges: MatchRange[]): MultipleMatchesDiagnostic {
  return { reason: "multiple_matches", occurrences: ranges.map((r) => lineNumberAt(raw, r.start)) };
}
