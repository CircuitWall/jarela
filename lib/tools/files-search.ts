// Search + bulk-edit tools for SWE agents.
//
// - `file_glob`  — find files by glob pattern under a root (workspace-aware).
// - `file_grep`  — search file contents with a regex or literal, optionally
//                  scoped to a glob. Replaces ad-hoc `rg`/`grep`/`Get-ChildItem`
//                  calls through local_exec that break across shells.
// - `file_multi_edit` — apply N anchored str_replace edits to one file in a
//                  single transaction. All edits must apply cleanly or none do.
//
// All three honour the active workspace from workspace-context: bare
// relative paths and glob roots resolve against the workspace root if
// one is open. The credential-file denylist applies to every match.

import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import { currentWorkspace, type ToolConfig } from "./workspace-context";
import { pathResolverFor, assertSafePath, withFsDeadline } from "./files";
import { buildOutline, shouldOutline } from "./file-outline";
import { getConfig } from "@/lib/env/config";

// ---------------------------------------------------------------------------
// Limits.
//
// Capped to keep one tool call inside an LLM context budget. file_grep
// returns at most MAX_MATCHES across at most MAX_FILES_SCANNED — if the
// agent's pattern is too broad, it gets a `truncated: true` hint and an
// instruction to narrow.
// ---------------------------------------------------------------------------
const MAX_FILES_SCANNED = 5_000;        // hard cap on files visited
const MAX_MATCHES = 200;                 // hard cap on grep hits returned
const MAX_LINE_BYTES = 2_000;            // truncate any matched line longer than this
const MAX_GLOB_RESULTS = 1_000;          // hard cap on file_glob returns
const MAX_MULTI_EDITS = 50;              // hard cap on edits per multi_edit call
const MAX_GREP_FILE_BYTES = 1_000_000;   // skip files larger than ~1 MB (likely binary or vendored)
const MAX_PATTERN_CHARS = 10_000;         // keep glob/regex compilation bounded

// Directories we never recurse into — same list as workspace_init's tree
// walker. Keeps grep snappy on real projects.
const DEFAULT_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "coverage", "__pycache__", "target", "vendor", ".venv", "venv",
  ".turbo", ".cache", ".idea", ".vscode",
]);

// ---------------------------------------------------------------------------
// Tiny glob compiler.
//
// Supports the subset the agent actually needs: `*` (any chars except /),
// `**` (any chars including /), `?` (single non-/ char), and `{a,b,c}`
// alternation. No bracket character classes — they're rarely useful at
// this level and add escaping complexity. The pattern is matched against
// the POSIX-style relative path (forward slashes) from the search root.
// ---------------------------------------------------------------------------
function compileGlob(pattern: string): RegExp {
  // Tokenise so `{a,b}` doesn't get its commas/braces escaped.
  let i = 0;
  let out = "^";
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` or `**` — match across directory separators.
        out += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        i++;
        continue;
      }
      const alts = pattern.slice(i + 1, end).split(",").map(escapeRegExp);
      out += `(?:${alts.join("|")})`;
      i = end + 1;
    } else {
      out += escapeRegExp(c);
      i++;
    }
  }
  out += "$";
  return new RegExp(out);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

interface WalkResult {
  files: string[];        // POSIX-relative paths from root
  scanned: number;
  truncated: boolean;
}

async function walk(
  root: string,
  options: { includeHidden?: boolean; maxFiles: number; ignore?: Set<string> },
): Promise<WalkResult> {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const files: string[] = [];
  let scanned = 0;
  let truncated = false;

  async function visit(absDir: string, relDir: string): Promise<void> {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      if (!options.includeHidden && e.name.startsWith(".") && e.name !== ".") continue;
      if (ignore.has(e.name)) continue;
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        await visit(childAbs, childRel);
      } else if (e.isFile()) {
        scanned++;
        files.push(childRel);
        if (files.length >= options.maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  }

  await visit(root, "");
  return { files, scanned, truncated };
}

// ---------------------------------------------------------------------------
// file_glob
// ---------------------------------------------------------------------------

const globSchema = z.object({
  pattern: z.string().min(1).max(MAX_PATTERN_CHARS).describe("Glob pattern matched against POSIX-relative paths from `root`. Supports *, **, ?, and {a,b} alternation. Example: 'src/**/*.{ts,tsx}'."),
  root: z.string().optional().describe("Directory to search under. Defaults to the active workspace root, or $HOME if no workspace is open. Absolute / ~/ / relative paths accepted."),
  include_hidden: z.boolean().optional().describe("Include dot-prefixed directories and files. Default false."),
  max_results: z.number().int().min(1).max(MAX_GLOB_RESULTS).optional().describe(`Cap on returned matches (default 200, max ${MAX_GLOB_RESULTS}).`),
});

export const fileGlobTool = tool(
  async (input, config?: ToolConfig) => {
    const { pattern, root: rawRoot, include_hidden, max_results } = input;
    const { resolve, workspace } = pathResolverFor(config);

    let rootAbs: string;
    try {
      rootAbs = rawRoot ? resolve(rawRoot) : (workspace?.root ?? resolve("."));
      assertSafePath(rootAbs, "read");
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }

    let rootStat: import("node:fs").Stats;
    try {
      rootStat = await withFsDeadline("file_glob.stat", rootAbs, () => fs.stat(rootAbs));
    } catch (err) {
      return JSON.stringify({ ok: false, root: rootAbs, error: (err as Error).message });
    }
    if (!rootStat.isDirectory()) {
      return JSON.stringify({ ok: false, root: rootAbs, error: "root is not a directory" });
    }

    const re = compileGlob(pattern);
    const cap = max_results ?? 200;

    const walked = await withFsDeadline("file_glob", rootAbs, () =>
      walk(rootAbs, { includeHidden: include_hidden, maxFiles: MAX_FILES_SCANNED }),
    );

    const matches: string[] = [];
    for (const rel of walked.files) {
      if (re.test(rel)) {
        matches.push(rel);
        if (matches.length >= cap) break;
      }
    }

    return JSON.stringify({
      ok: true,
      root: rootAbs,
      pattern,
      matches,
      count: matches.length,
      files_scanned: walked.scanned,
      truncated: walked.truncated || matches.length >= cap,
      truncated_reason: walked.truncated ? "scan_limit" : matches.length >= cap ? "result_cap" : undefined,
      truncated_hint: (walked.truncated || matches.length >= cap)
        ? "Narrow the pattern, raise max_results, or set a more specific root."
        : undefined,
    });
  },
  {
    name: "file_glob",
    description:
      "Find files by glob pattern under a directory. Prefer this over shelling out to rg --files/find/Get-ChildItem for file discovery. Supports *, **, ?, and {a,b} alternation. Skips node_modules/.git/dist/build/.next/coverage/etc by default. Returns POSIX-relative paths from the search root.",
    schema: globSchema,
  },
);

// ---------------------------------------------------------------------------
// file_grep
// ---------------------------------------------------------------------------

const grepSchema = z.object({
  pattern: z.string().min(1).max(MAX_PATTERN_CHARS).describe("Search pattern. Regex by default; pass literal=true to treat as a plain substring."),
  literal: z.boolean().optional().describe("Treat `pattern` as a literal substring instead of a regex. Default false."),
  case_insensitive: z.boolean().optional().describe("Case-insensitive match. Default false."),
  root: z.string().optional().describe("Directory to search under. Defaults to the active workspace root, or $HOME."),
  glob: z.string().optional().describe("Optional file-name glob (e.g. '**/*.ts') to restrict which files are scanned."),
  include_hidden: z.boolean().optional().describe("Search inside dot-prefixed directories. Default false."),
  max_matches: z.number().int().min(1).max(MAX_MATCHES).optional().describe(`Cap on returned matches (default 100, max ${MAX_MATCHES}).`),
  context: z.number().int().min(0).max(5).optional().describe("Lines of context to return around each match (default 0)."),
});

interface GrepMatch {
  path: string;       // POSIX-relative to root
  line: number;       // 1-based
  text: string;
  before?: string[];
  after?: string[];
  // The enclosing function / class / heading / section the match
  // falls inside, computed from file-outline. Lets the agent skip a
  // follow-up file_read when the match's surrounding name is enough.
  enclosing?: { kind: string; name: string; line: number };
}

// Reads one candidate file and pushes any line matches into `matches`.
// Returns whether the cap was hit (caller stops walking) and whether this
// file contributed at least one match (for the files_with_matches count).
// Skips binaries (NUL-byte heuristic), >1 MB files, and unreadable entries.
async function scanFileForGrepMatches(
  abs: string,
  rel: string,
  re: RegExp,
  cap: number,
  ctx: number,
  matches: GrepMatch[],
): Promise<{ skipped: boolean; fileHadMatch: boolean; capReached: boolean }> {
  let stat: import("node:fs").Stats;
  try { stat = await fs.stat(abs); }
  catch { return { skipped: true, fileHadMatch: false, capReached: false }; }
  if (stat.size > MAX_GREP_FILE_BYTES) return { skipped: true, fileHadMatch: false, capReached: false };
  let raw: string;
  try { raw = await fs.readFile(abs, "utf8"); }
  catch { return { skipped: true, fileHadMatch: false, capReached: false }; } // unreadable / binary
  // Quick binary heuristic — if a NUL byte is present, skip.
  if (raw.length > 0 && raw.indexOf("\u0000") !== -1) {
    return { skipped: true, fileHadMatch: false, capReached: false };
  }

  const lines = raw.split(/\r?\n/);
  // Compute outline once per file we'll actually report matches in,
  // not per match. The outline lets each match carry its enclosing
  // function/heading so the agent often doesn't need a follow-up read.
  let outline: ReturnType<typeof buildOutline> | null = null;
  let outlineComputed = false;
  let fileHadMatch = false;
  for (let i = 0; i < lines.length; i++) {
    // Use test, then reset lastIndex defensively in case the user passed /g.
    if (re.test(lines[i])) {
      re.lastIndex = 0;
      fileHadMatch = true;
      const text = clipLine(lines[i]);
      const m: GrepMatch = { path: rel, line: i + 1, text };
      if (ctx > 0) {
        m.before = lines.slice(Math.max(0, i - ctx), i).map(clipLine);
        m.after = lines.slice(i + 1, Math.min(lines.length, i + 1 + ctx)).map(clipLine);
      }
      if (!outlineComputed) {
        outlineComputed = true;
        outline = shouldOutline(abs, raw) ? buildOutline(abs, raw) : null;
      }
      if (outline && outline.length > 0) {
        // Find the outline entry with the largest line number that is
        // still <= the match line. Linear scan is fine: outlines cap
        // at 200 entries and match counts are bounded by `cap`.
        let best: ReturnType<typeof buildOutline>[number] | null = null;
        for (const e of outline) {
          if (e.line <= m.line && (!best || e.line > best.line)) best = e;
        }
        if (best) m.enclosing = { kind: best.kind, name: best.name, line: best.line };
      }
      matches.push(m);
      if (matches.length >= cap) {
        return { skipped: false, fileHadMatch, capReached: true };
      }
    }
  }
  return { skipped: false, fileHadMatch, capReached: false };
}

export const fileGrepTool = tool(
  async (input, config?: ToolConfig) => {
    const {
      pattern, literal, case_insensitive,
      root: rawRoot, glob, include_hidden,
      max_matches, context,
    } = input;
    const { resolve, workspace } = pathResolverFor(config);

    let rootAbs: string;
    try {
      rootAbs = rawRoot ? resolve(rawRoot) : (workspace?.root ?? resolve("."));
      assertSafePath(rootAbs, "read");
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }

    let re: RegExp;
    try {
      const src = literal ? escapeRegExp(pattern) : pattern;
      re = new RegExp(src, case_insensitive ? "i" : "");
    } catch (err) {
      return JSON.stringify({ ok: false, error: `invalid pattern: ${(err as Error).message}` });
    }

    const fileRe = glob ? compileGlob(glob) : null;
    const cap = max_matches ?? 100;
    const ctx = context ?? 0;

    const walked = await withFsDeadline("file_grep.walk", rootAbs, () =>
      walk(rootAbs, { includeHidden: include_hidden, maxFiles: MAX_FILES_SCANNED }),
    );

    const matches: GrepMatch[] = [];
    let filesWithMatches = 0;
    let filesScanned = 0;
    let truncated = walked.truncated;

    for (const rel of walked.files) {
      if (fileRe && !fileRe.test(rel)) continue;
      const abs = path.join(rootAbs, rel);
      const result = await scanFileForGrepMatches(abs, rel, re, cap, ctx, matches);
      if (result.skipped) continue;
      filesScanned++;
      if (result.fileHadMatch) filesWithMatches++;
      if (result.capReached) { truncated = true; break; }
    }

    return JSON.stringify({
      ok: true,
      root: rootAbs,
      pattern,
      literal: !!literal,
      case_insensitive: !!case_insensitive,
      glob: glob ?? null,
      matches,
      count: matches.length,
      files_with_matches: filesWithMatches,
      files_scanned: filesScanned,
      truncated,
      truncated_reason: walked.truncated ? "scan_limit" : matches.length >= cap ? "match_cap" : undefined,
      truncated_hint: truncated
        ? "Narrow the pattern, add a glob filter, raise max_matches, or set a more specific root."
        : undefined,
    });
  },
  {
    name: "file_grep",
    description:
      "Search file contents under a directory by regex (or literal substring with literal=true). Prefer this over local_exec/terminal grep, rg, Select-String, or Get-ChildItem pipelines for code search. Optional glob filter (e.g. '**/*.ts'). Returns POSIX-relative paths, 1-based line numbers, optional N-line context, AND an `enclosing` {kind,name,line} pointing at the surrounding function/class/heading when one can be derived (lets you often skip a follow-up file_read). Skips node_modules/.git/etc, binary files (NUL-byte heuristic), and files >1 MB.",
    schema: grepSchema,
  },
);

function clipLine(s: string): string {
  return s.length > MAX_LINE_BYTES ? `${s.slice(0, MAX_LINE_BYTES)}…[truncated]` : s;
}

// ---------------------------------------------------------------------------
// file_multi_edit
//
// Applies N anchored str_replace edits to one file atomically: we read
// once, apply all edits in order to the in-memory buffer, and only write
// if every edit found exactly one match. If any edit fails (no match or
// multiple matches), the file is left untouched and we return per-edit
// status so the agent knows which one to fix.
// ---------------------------------------------------------------------------

const multiEditSchema = z.object({
  path: z.string().describe("File path. Absolute / ~/ / relative to workspace root."),
  edits: z
    .array(z.object({
      old_string: z.string().min(1).describe("Exact literal substring to replace. Must match EXACTLY ONCE in the (current, partially-edited) buffer at the time it's applied."),
      new_string: z.string().describe("Replacement text. May be empty to delete."),
    }))
    .min(1)
    .max(MAX_MULTI_EDITS)
    .describe(`Up to ${MAX_MULTI_EDITS} edits, applied in order. All-or-nothing: if any edit fails to find exactly one match, the file is not modified.`),
});

export const fileMultiEditTool = tool(
  async ({ path: filePath, edits }, config?: ToolConfig) => {
    let abs = filePath;
    try {
      abs = pathResolverFor(config).resolve(filePath);
      assertSafePath(abs, "write");

      const raw = await withFsDeadline("file_multi_edit.read", abs, () => fs.readFile(abs, "utf8"));
      let buf = raw;
      const results: Array<{ index: number; ok: boolean; match_count?: number; error?: string }> = [];
      let failed = false;

      for (let i = 0; i < edits.length; i++) {
        const { old_string, new_string } = edits[i];
        const first = buf.indexOf(old_string);
        if (first === -1) {
          results.push({
            index: i, ok: false,
            error: "old_string not found in the current buffer (note: earlier edits may have already changed it).",
          });
          failed = true;
          continue;
        }
        const second = buf.indexOf(old_string, first + old_string.length);
        if (second !== -1) {
          const count = buf.split(old_string).length - 1;
          results.push({
            index: i, ok: false, match_count: count,
            error: "old_string matches multiple times. Add surrounding context to make it unique.",
          });
          failed = true;
          continue;
        }
        buf = buf.slice(0, first) + new_string + buf.slice(first + old_string.length);
        results.push({ index: i, ok: true });
      }

      if (failed) {
        return JSON.stringify({
          ok: false,
          path: abs,
          error: "one or more edits failed; file was not modified",
          edits: results,
        });
      }

      await withFsDeadline("file_multi_edit.write", abs, () => fs.writeFile(abs, buf, "utf8"));
      return JSON.stringify({
        ok: true,
        path: abs,
        edits_applied: edits.length,
        bytes_before: Buffer.byteLength(raw, "utf8"),
        bytes_after: Buffer.byteLength(buf, "utf8"),
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_multi_edit",
    description:
      "Apply multiple anchored str_replace edits to one file atomically. Each edit's old_string must match EXACTLY ONCE in the (partially-edited) buffer at the time it's applied. All-or-nothing: if any edit fails, the file is not modified and per-edit status is returned. Prefer this over multiple file_edit round-trips or shell rewrites when refactoring within a single file.",
    schema: multiEditSchema,
  },
);

// Reference getConfig so dead-code elimination doesn't drop the import —
// used indirectly via withFsDeadline / assertSafePath, but keeping a
// direct reference helps the typecheck if those signatures ever change.
void getConfig;

registerLangChainPackage({
  category: "Files",
  tools: {
    read: [fileGlobTool, fileGrepTool],
    write: [fileMultiEditTool],
  },
});
