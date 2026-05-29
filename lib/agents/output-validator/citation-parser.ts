import type { Citation } from "./types";

// Matches `(via NAME)` and `(via NAME ARG1 ARG2)` and `(via NAME, file: ...)`.
// Captures the tool name (first whitespace-delimited identifier-ish token).
// Ignores file-path citations like `(lib/foo.ts:42)` and memory citations
// like `(memory: ns/key)` — those are not tool-call claims.
const VIA_RE = /\(\s*via\s+([A-Za-z_][\w-]*)[^)]*\)/g;

export function findCitations(text: string): Citation[] {
  const out: Citation[] = [];
  VIA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VIA_RE.exec(text)) !== null) {
    out.push({ tool: m[1], raw: m[0] });
  }
  return out;
}
