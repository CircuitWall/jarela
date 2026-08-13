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

function dedupeLines(
  source: string,
  opts: { trim: boolean; ignoreCase: boolean; skipBlank: boolean; keep: "first" | "last" },
): { text: string; removed: number } {
  const lines = source.split(/\r?\n/);
  const keyed = lines.map((line) => {
    const normalized = opts.trim ? line.trim() : line;
    return opts.ignoreCase ? normalized.toLowerCase() : normalized;
  });

  const keep = new Set<number>();
  const visit = opts.keep === "first"
    ? [...keyed.keys()]
    : [...keyed.keys()].reverse();
  const seen = new Set<string>();
  for (const idx of visit) {
    const key = keyed[idx];
    if (opts.skipBlank && key.length === 0) {
      keep.add(idx);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    keep.add(idx);
  }
  const next = lines.filter((_, idx) => keep.has(idx));
  return { text: next.join("\n"), removed: lines.length - next.length };
}

function dedupeParagraphs(
  source: string,
  opts: { trim: boolean; ignoreCase: boolean; keep: "first" | "last" },
): { text: string; removed: number } {
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const keys = paragraphs.map((p) => {
    const base = opts.trim ? p.trim() : p;
    return opts.ignoreCase ? base.toLowerCase() : base;
  });
  const keep = new Set<number>();
  const visit = opts.keep === "first"
    ? [...keys.keys()]
    : [...keys.keys()].reverse();
  const seen = new Set<string>();
  for (const idx of visit) {
    const key = keys[idx];
    if (seen.has(key)) continue;
    seen.add(key);
    keep.add(idx);
  }
  const next = paragraphs.filter((_, idx) => keep.has(idx));
  return { text: next.join("\n\n"), removed: paragraphs.length - next.length };
}
