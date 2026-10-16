export type InstructionEditOp =
  | {
      op: "append";
      text?: unknown;
      if_missing?: unknown;
      ignore_case?: unknown;
    }
  | {
      op: "prepend";
      text?: unknown;
      if_missing?: unknown;
      ignore_case?: unknown;
    }
  | {
      op: "replace";
      find?: unknown;
      replace?: unknown;
      all?: unknown;
      ignore_case?: unknown;
    }
  | {
      op: "remove";
      text?: unknown;
      all?: unknown;
      ignore_case?: unknown;
    }
  | {
      op: "dedupe_lines";
      trim?: unknown;
      ignore_case?: unknown;
      skip_blank?: unknown;
      keep?: unknown;
    }
  | {
      op: "dedupe_paragraphs";
      trim?: unknown;
      ignore_case?: unknown;
      keep?: unknown;
    };

export function applyInstructionEdits(
  base: string,
  editsInput: unknown,
): { ok: true; text: string; summary: Array<Record<string, unknown>> } | { ok: false; error: string } {
  if (!Array.isArray(editsInput)) {
    return { ok: false, error: "instructions_edits must be an array" };
  }
  let text = base;
  const summary: Array<Record<string, unknown>> = [];
  for (let i = 0; i < editsInput.length; i += 1) {
    const raw = editsInput[i];
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `instructions_edits[${i}] must be an object` };
    }
    const op = raw as InstructionEditOp;
    if (typeof op.op !== "string") {
      return { ok: false, error: `instructions_edits[${i}].op is required` };
    }
    switch (op.op) {
      case "append": {
        if (typeof op.text !== "string") {
          return { ok: false, error: `instructions_edits[${i}].text must be a string` };
        }
        const ifMissing = !!op.if_missing;
        const ignoreCase = !!op.ignore_case;
        const shouldAppend = !ifMissing || !containsText(text, op.text, ignoreCase);
        if (shouldAppend) text += op.text;
        summary.push({ index: i, op: "append", applied: shouldAppend });
        break;
      }
      case "prepend": {
        if (typeof op.text !== "string") {
          return { ok: false, error: `instructions_edits[${i}].text must be a string` };
        }
        const ifMissing = !!op.if_missing;
        const ignoreCase = !!op.ignore_case;
        const shouldPrepend = !ifMissing || !containsText(text, op.text, ignoreCase);
        if (shouldPrepend) text = op.text + text;
        summary.push({ index: i, op: "prepend", applied: shouldPrepend });
        break;
      }
      case "replace": {
        if (typeof op.find !== "string") {
          return { ok: false, error: `instructions_edits[${i}].find must be a string` };
        }
        if (typeof op.replace !== "string") {
          return { ok: false, error: `instructions_edits[${i}].replace must be a string` };
        }
        const out = replaceLiteral(text, op.find, op.replace, !!op.all, !!op.ignore_case);
        text = out.text;
        summary.push({ index: i, op: "replace", replacements: out.replacements });
        break;
      }
      case "remove": {
        if (typeof op.text !== "string") {
          return { ok: false, error: `instructions_edits[${i}].text must be a string` };
        }
        const out = replaceLiteral(text, op.text, "", !!op.all, !!op.ignore_case);
        text = out.text;
        summary.push({ index: i, op: "remove", removals: out.replacements });
        break;
      }
      case "dedupe_lines": {
        const out = dedupeLines(
          text,
          {
            trim: op.trim !== false,
            ignoreCase: op.ignore_case !== false,
            skipBlank: op.skip_blank !== false,
            keep: op.keep === "last" ? "last" : "first",
          },
        );
        text = out.text;
        summary.push({ index: i, op: "dedupe_lines", removed: out.removed });
        break;
      }
      case "dedupe_paragraphs": {
        const out = dedupeParagraphs(text, {
          trim: op.trim !== false,
          ignoreCase: op.ignore_case !== false,
          keep: op.keep === "last" ? "last" : "first",
        });
        text = out.text;
        summary.push({ index: i, op: "dedupe_paragraphs", removed: out.removed });
        break;
      }
      default:
        return { ok: false, error: `instructions_edits[${i}].op is not supported` };
    }
  }
  return { ok: true, text, summary };
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteral(
  source: string,
  find: string,
  replacement: string,
  all: boolean,
  ignoreCase: boolean,
): { text: string; replacements: number } {
  if (!find) return { text: source, replacements: 0 };
  if (!ignoreCase) {
    if (all) {
      const parts = source.split(find);
      if (parts.length <= 1) return { text: source, replacements: 0 };
      return { text: parts.join(replacement), replacements: parts.length - 1 };
    }
    const idx = source.indexOf(find);
    if (idx < 0) return { text: source, replacements: 0 };
    return {
      text: source.slice(0, idx) + replacement + source.slice(idx + find.length),
      replacements: 1,
    };
  }

  const flags = all ? "gi" : "i";
  const re = new RegExp(escapeRegex(find), flags);
  let replacements = 0;
  const text = source.replace(re, () => {
    replacements += 1;
    return replacement;
  });
  return { text, replacements };
}

function containsText(source: string, needle: string, ignoreCase: boolean): boolean {
  if (!ignoreCase) return source.includes(needle);
  return source.toLowerCase().includes(needle.toLowerCase());
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HORIZONTAL_RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/**
 * Drop duplicate segments from `parts`, which alternates content (even
 * indexes) and the original separator that follows it (odd indexes).
 * Separators are preserved verbatim, so only removed segments change the
 * text. `keyOf` returns null for a segment that must always be kept.
 */
function dedupeSegments(
  parts: readonly string[],
  keyOf: (segmentIndex: number) => string | null,
  keep: "first" | "last",
): { text: string; removed: number } {
  const contentIdx = parts.map((_, i) => i).filter((i) => i % 2 === 0);
  const visit = keep === "first" ? contentIdx : [...contentIdx].reverse();
  const seen = new Set<string>();
  const dropped = new Set<number>();
  for (const idx of visit) {
    const key = keyOf(idx);
    if (key === null) continue;
    if (seen.has(key)) dropped.add(idx);
    else seen.add(key);
  }
  if (dropped.size === 0) return { text: parts.join(""), removed: 0 };
  let text = "";
  let emitted = false;
  for (const idx of contentIdx) {
    if (dropped.has(idx)) continue;
    if (emitted && idx > 0) text += parts[idx - 1];
    text += parts[idx];
    emitted = true;
  }
  return { text, removed: dropped.size };
}

function dedupeLines(
  source: string,
  opts: { trim: boolean; ignoreCase: boolean; skipBlank: boolean; keep: "first" | "last" },
): { text: string; removed: number } {
  const parts = source.split(/(\r?\n)/);
  // Fence markers, fenced code and horizontal rules repeat by design; a
  // closing ``` is always a "duplicate" of the opening one.
  const protectedIdx = new Set<number>();
  let fence: string | null = null;
  for (let i = 0; i < parts.length; i += 2) {
    const marker = FENCE_RE.exec(parts[i])?.[1];
    if (fence !== null) {
      protectedIdx.add(i);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(parts[i])) fence = null;
    } else if (marker) {
      protectedIdx.add(i);
      fence = marker;
    } else if (HORIZONTAL_RULE_RE.test(parts[i])) {
      protectedIdx.add(i);
    }
  }
  return dedupeSegments(parts, (i) => {
    if (protectedIdx.has(i)) return null;
    const normalized = opts.trim ? parts[i].trim() : parts[i];
    if (opts.skipBlank && normalized.length === 0) return null;
    return opts.ignoreCase ? normalized.toLowerCase() : normalized;
  }, opts.keep);
}

function dedupeParagraphs(
  source: string,
  opts: { trim: boolean; ignoreCase: boolean; keep: "first" | "last" },
): { text: string; removed: number } {
  const tail = /\s*$/.exec(source)?.[0] ?? "";
  const parts = source.slice(0, source.length - tail.length).split(/(\r?\n(?:[ \t]*\r?\n)+)/);
  const out = dedupeSegments(parts, (i) => {
    if (parts[i].trim().length === 0) return null;
    const base = opts.trim ? parts[i].trim() : parts[i];
    return opts.ignoreCase ? base.toLowerCase() : base;
  }, opts.keep);
  return { text: out.text + tail, removed: out.removed };
}