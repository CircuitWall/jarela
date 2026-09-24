import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { checkFsAllowed, resolveSafetyMode } from "../security/safety";
import { getConfig } from "@/lib/env/config";
import { currentWorkspace, type ToolConfig } from "./workspace-context";
import { buildOutline, capOutline, shouldOutline } from "./file-outline";
import {
  locateOldString,
  buildNotFoundDiagnostic,
  buildMultipleMatchesDiagnostic,
  dominantEol,
  conformEol,
} from "./edit-match";

// Dedicated file tools. Agents previously had to drive every edit through
// `local_exec` / `terminal`, which works for "create a new file with this
// content" (echo / Set-Content) but is hostile to in-place edits: quoting
// rules differ per shell, multi-line strings break under cmd.exe, and a
// read-modify-write cycle needs two shell calls plus careful diff-by-hand.
// These tools give agents a first-class file write + targeted edit surface.

// JARELA_FILES_MAX_READ_BYTES / JARELA_FILES_MAX_WRITE_BYTES override these.
// MAX_LIST_JSON_BYTES isn't user-tunable: the cap exists to keep file_list
// JSON inside one LLM context budget; raising it just shifts the failure.
function maxReadBytes(): number { return getConfig().filesMaxReadBytes; }
function maxWriteBytes(): number { return getConfig().filesMaxWriteBytes; }
const MAX_LIST_JSON_BYTES = 24_000;

// Wall-clock deadline for a single fs.* call. Cloud-sync filesystem
// providers (OneDrive, iCloud, Dropbox), network mounts, and aggressive
// AV scanners can wedge fs.writeFile/readFile/mkdir indefinitely. Without
// a deadline the agent loop just spins until the run-registry idle
// watchdog (90s default) force-finishes the run with a generic "run
// timed out" — the user never learns it was a stuck fs op. With this,
// the deadline fires first and a structured error envelope tells the
// agent (and the user) which path stalled.
//
// This is a hardcoded leak-prevention backstop. The agent-controlled
// wall-clock budget on every tool call (see lib/tools/wallclock.ts) is
// the primary deadline; this only fires when the wallclock is even
// longer than the backstop (e.g. a 10-minute build that includes a
// stuck file op).
const FS_DEADLINE_BACKSTOP_MS = 360_000;
export async function withFsDeadline<T>(
  label: string,
  abs: string,
  work: () => Promise<T>,
  deadlineMs: number = FS_DEADLINE_BACKSTOP_MS,
): Promise<T> {
  const ms = deadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label} on '${abs}' timed out after ${Math.round(ms / 1000)}s — the path may be on a stalled filesystem (cloud-sync provider, network mount, AV scanner). Try a different location.`,
    )), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clip(text: string, max: number): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

// Resolve agent-supplied paths.
//
// - `~` and `~/foo` always resolve against $HOME.
// - Absolute paths are honoured verbatim.
// - Bare relative paths resolve against `workspaceRoot` if one is set
//   (the agent called `workspace_init`), otherwise against $HOME.
//
// In production cwd is the Jarela install dir
// (%LOCALAPPDATA%\Programs\Jarela) — if the agent writes "notes.txt"
// expecting it to land somewhere visible, it lands buried in the install
// tree and the user concludes the tool didn't run. Home is the natural
// default for an "assistant on my computer"; the workspace root takes
// priority once the agent has declared one.
function resolvePath(p: string, workspaceRoot?: string): string {
  if (!p.trim()) throw new Error("path is required");
  let s = p.trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(os.homedir(), s.slice(2));
    return path.resolve(s);
  }
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(workspaceRoot ?? os.homedir(), s);
}

/**
 * Resolver factory bound to the current tool call's workspace context.
 * Returns a `resolve()` that handles ~/abs/relative paths and enforces
 * `scoped: true` (absolute paths outside the workspace root are refused).
 */
export function pathResolverFor(config?: ToolConfig): {
  resolve: (p: string) => string;
  workspace?: ReturnType<typeof currentWorkspace>;
} {
  const workspace = currentWorkspace(config);
  return {
    workspace,
    resolve: (p: string): string => {
      const abs = resolvePath(p, workspace?.root);
      if (workspace?.scoped && !isInside(abs, workspace.root)) {
        throw new Error(
          `refused: '${abs}' is outside the scoped workspace '${workspace.root}'. ` +
            `Call workspace_init with scoped=false to allow paths outside the project, or use a relative path.`,
        );
      }
      return abs;
    },
  };
}

// Filesystem denylist for agent-driven file tools. The LLM has free
// rein over the user's HOME by design — but a handful of subtrees hold
// credentials whose disclosure or mutation is far more dangerous than
// any chat use case justifies: SSH private keys, GPG secret rings,
// cached cloud-provider tokens, the gh CLI auth blob, kubeconfig, the
// docker daemon config. We also forbid writes to ~/.jarela so a
// prompt-injected page can't rewrite the app's own SQLite state.
//
// Operators with an explicit need (e.g. asking the agent to fix an
// authorized_keys file) can opt back in with
// JARELA_ALLOW_SENSITIVE_FILES=1.
function isInside(abs: string, parent: string): boolean {
  // Walk up to the nearest existing ancestor before calling realpathSync so
  // that intermediate symlinks are followed even when the leaf doesn't exist
  // yet (new-file write case). A simple try/catch fallback to path.resolve
  // would miss e.g. /safe/evil_link/newfile where evil_link→/etc: realpathSync
  // throws ENOENT on the non-existent leaf, the catch returns the lexical path,
  // and path.relative produces no ".." — isInside returns true incorrectly.
  const resolveReal = (p: string): string => {
    let current = p;
    const tail: string[] = [];
    for (;;) {
      try {
        const real = realpathSync(current);
        return tail.reduceRight((acc, seg) => path.join(acc, seg), real);
      } catch {
        const up = path.dirname(current);
        if (up === current) return p; // reached fs root, give up
        tail.push(path.basename(current));
        current = up;
      }
    }
  };
  const a = resolveReal(path.resolve(abs));
  const p = resolveReal(path.resolve(parent));
  if (a === p) return true;
  const rel = path.relative(p, a);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sensitiveBase(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gh"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
  ];
}

function sensitiveFiles(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".netrc"),
    path.join(home, "_netrc"), // Windows convention
    path.join(home, ".pgpass"),
  ];
}

function jarelaDataDir(): string {
  return process.env.JARELA_DB_DIR
    ? path.resolve(process.env.JARELA_DB_DIR)
    : path.join(os.homedir(), ".jarela");
}

export function assertSafePath(abs: string, op: "read" | "write"): void {
  const mode = resolveSafetyMode();
  const gate = checkFsAllowed(op, { mode });
  if (!gate.allowed) throw new Error(gate.reason);
  // bypass mode disables every guard, including the credential denylist.
  if (mode === "bypass") return;
  if (process.env.JARELA_ALLOW_SENSITIVE_FILES === "1") return;
  for (const base of sensitiveBase()) {
    if (isInside(abs, base)) {
      throw new Error(
        `refused: '${abs}' is inside a credential directory (${path.basename(base)}). ` +
          `Set JARELA_ALLOW_SENSITIVE_FILES=1 to override.`,
      );
    }
  }
  for (const f of sensitiveFiles()) {
    if (path.resolve(abs) === path.resolve(f)) {
      throw new Error(
        `refused: '${abs}' is a credential file. Set JARELA_ALLOW_SENSITIVE_FILES=1 to override.`,
      );
    }
  }
  // Filename-based defense: catch private-key files anywhere on disk.
  const base = path.basename(abs).toLowerCase();
  if (
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base === "id_ecdsa" ||
    base === "id_dsa" ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base === "credentials"
  ) {
    throw new Error(
      `refused: '${abs}' looks like a credential file. Set JARELA_ALLOW_SENSITIVE_FILES=1 to override.`,
    );
  }
  if (op === "write" && isInside(abs, jarelaDataDir())) {
    throw new Error(
      `refused: '${abs}' is inside Jarela's data dir; the agent must not mutate app state directly.`,
    );
  }
}

// --- read ---------------------------------------------------------------

const readSchema = z.object({
  path: z.string().describe("File path. Absolute (C:\\... or /...) or ~/foo recommended; bare relative paths resolve against the user's HOME directory."),
  start_line: z.number().int().min(1).optional().describe("1-based first line to include"),
  end_line: z.number().int().min(1).optional().describe("1-based last line to include (inclusive)"),
});

export const fileReadTool = tool(
  async ({ path: filePath, start_line, end_line }, config?: ToolConfig) => {
    let abs = filePath;
    try {
      abs = pathResolverFor(config).resolve(filePath);
      assertSafePath(abs, "read");
      const raw = await withFsDeadline("file_read", abs, () => fs.readFile(abs, "utf8"));
      let content = raw;
      let lineRange: { start: number; end: number } | null = null;
      if (start_line || end_line) {
        const lines = raw.split(/\r?\n/);
        const s = Math.max(1, start_line ?? 1);
        const e = Math.min(lines.length, end_line ?? lines.length);
        content = lines.slice(s - 1, e).join("\n");
        lineRange = { start: s, end: e };
      }
      const clipped = clip(content, maxReadBytes());
      // Attach a structural outline on exploration reads only — when
      // the agent already passed a line range it knows where it's
      // going and the outline would just be noise. The outline lets
      // the next call jump directly to a function / heading via
      // start_line/end_line instead of grepping and guessing.
      const exploring = !start_line && !end_line;
      let outline: { entries: ReturnType<typeof buildOutline>; truncated: boolean } | null = null;
      if (exploring && shouldOutline(abs, raw)) {
        const built = buildOutline(abs, raw);
        if (built.length > 0) outline = capOutline(built);
      }
      return JSON.stringify({
        ok: true,
        path: abs,
        content: clipped.value,
        truncated: clipped.truncated,
        line_range: lineRange,
        total_lines: raw.split(/\r?\n/).length,
        outline: outline?.entries ?? null,
        outline_truncated: outline?.truncated ?? false,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_read",
    description:
      "Read a UTF-8 text file. Prefer file_glob/file_grep to locate targets before reading; avoid shell cat/type/Get-Content for normal file inspection. Optional 1-based start_line/end_line slice. Output clipped at 64 KB — for large files always pass a line range and walk in chunks. When called without a line range on a recognised text file, the response also includes an `outline` array of {kind,name,line} entries (markdown headings, top-level functions/classes, config keys); feed those line numbers straight back into start_line/end_line on the next call to zoom in without grepping.",
    schema: readSchema,
  },
);

// --- write --------------------------------------------------------------

const CONTENT_REQUIRED_MESSAGE =
  "content is required — pass the full file body, not a patch or diff. For incremental changes use file_multi_edit.";

const writeSchema = z.object({
  path: z.string().describe("File path. Absolute (C:\\... or /...) or ~/foo recommended; bare relative paths resolve against the user's HOME directory."),
  content: z
    .string({ error: CONTENT_REQUIRED_MESSAGE })
    .min(1, CONTENT_REQUIRED_MESSAGE)
    .describe("Required: full UTF-8 file content, not a patch or partial fragment. Overwrites the file if it exists."),
  create_dirs: z
    .boolean()
    .optional()
    .describe("Create missing parent directories (default true)"),
});

export const fileWriteTool = tool(
  async ({ path: filePath, content, create_dirs }, config?: ToolConfig) => {
    let abs = filePath;
    try {
      abs = pathResolverFor(config).resolve(filePath);
      const cap = maxWriteBytes();
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (contentBytes > cap) {
        return JSON.stringify({ ok: false, path: abs, error: `content exceeds ${cap} bytes` });
      }
      assertSafePath(abs, "write");
      if (create_dirs !== false) {
        await withFsDeadline("file_write.mkdir", path.dirname(abs), () => fs.mkdir(path.dirname(abs), { recursive: true }));
      }
      let existed = true;
      try {
        await withFsDeadline("file_write.access", abs, () => fs.access(abs));
      } catch {
        existed = false;
      }
      await withFsDeadline("file_write", abs, () => fs.writeFile(abs, content, "utf8"));
      return JSON.stringify({
        ok: true,
        path: abs,
        bytes_written: Buffer.byteLength(content, "utf8"),
        created: !existed,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_write",
    description:
      "Create or fully overwrite a UTF-8 text file. The required content argument must contain the complete file contents, not a patch or partial fragment. Parent directories are created by default. Prefer file_edit or file_multi_edit for targeted changes to existing files; avoid shell heredocs/echo redirection for file writes.",
    schema: writeSchema,
  },
);

// --- edit ---------------------------------------------------------------

const editSchema = z.object({
  path: z.string().describe("File path. Absolute (C:\\... or /...) or ~/foo recommended; bare relative paths resolve against the user's HOME directory."),
  old_string: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact literal substring to replace. Must appear EXACTLY ONCE in the file (include surrounding context to disambiguate).",
    ),
  new_string: z.string().optional().describe("Replacement text. May be empty to delete."),
  content: z.string().min(1).optional().describe("One UTF-8 chunk for a large-file write. Use instead of old_string/new_string."),
  offset_bytes: z.number().int().min(0).optional().describe("Chunk mode: zero-based byte offset; use the previous result's next_offset."),
  truncate: z.boolean().optional().describe("Chunk mode: truncate before writing. Defaults true when offset_bytes is 0."),
  replace_all: z.boolean().optional().describe("Replace every non-overlapping match instead of requiring exactly one match. Default false."),
  strategy: z
    .enum(["exact", "trim_trailing", "normalize_whitespace", "fuzzy"])
    .optional()
    .describe(
      "Matching strategy, tried only after a plain exact match fails. 'exact' (default): byte-exact substring. 'trim_trailing': ignore trailing whitespace differences. 'normalize_whitespace': normalize line whitespace. 'fuzzy': allow small textual drift only when a unique high-confidence line block exists; ambiguous matches are refused. CRLF/LF differences are always tolerated.",
    ),
}).superRefine((value, ctx) => {
  const chunkMode = value.content !== undefined || value.offset_bytes !== undefined || value.truncate !== undefined;
  const replaceMode = value.old_string !== undefined || value.new_string !== undefined || value.replace_all !== undefined || value.strategy !== undefined;
  if (chunkMode && replaceMode) {
    ctx.addIssue({ code: "custom", message: "Use either chunk mode or replacement mode, not both." });
  } else if (!chunkMode && (!value.old_string || value.new_string === undefined)) {
    ctx.addIssue({ code: "custom", message: "Provide old_string and new_string, or provide content for chunk mode." });
  }
});

export const fileEditTool = tool(
  async ({ path: filePath, old_string, new_string, content, offset_bytes, truncate, replace_all, strategy }, config?: ToolConfig) => {
    let abs = filePath;
    let handle: import("node:fs/promises").FileHandle | undefined;
    try {
      abs = pathResolverFor(config).resolve(filePath);
      assertSafePath(abs, "write");
      if (content !== undefined) {
        const offset = offset_bytes ?? 0;
        const shouldTruncate = truncate ?? offset === 0;
        const data = Buffer.from(content, "utf8");
        const cap = maxWriteBytes();
        if (data.byteLength > cap) {
          return JSON.stringify({ ok: false, path: abs, error: `chunk exceeds ${cap} bytes` });
        }
        if (shouldTruncate) {
          await withFsDeadline("file_edit.mkdir", path.dirname(abs), () => fs.mkdir(path.dirname(abs), { recursive: true }));
        }
        handle = await withFsDeadline("file_edit.open", abs, () => fs.open(abs, shouldTruncate ? "w" : "r+"));
        const result = await withFsDeadline("file_edit.chunk", abs, () => handle!.write(data, 0, data.byteLength, offset));
        return JSON.stringify({
          ok: true,
          path: abs,
          offset_bytes: offset,
          bytes_written: result.bytesWritten,
          next_offset: offset + result.bytesWritten,
          truncated: shouldTruncate,
        });
      }
      const oldText = old_string ?? "";
      const replacementText = new_string ?? "";
      const raw = await withFsDeadline("file_edit.read", abs, () => fs.readFile(abs, "utf8"));
      const attempt = locateOldString(raw, oldText, strategy ?? "exact");
      if (attempt.ranges.length === 0) {
        return JSON.stringify({
          ok: false,
          path: abs,
          error: "old_string not found. Re-read the file and try with the exact current content.",
          diagnostic: buildNotFoundDiagnostic(raw, oldText),
        });
      }
      if (attempt.ranges.length > 1 && !replace_all) {
        return JSON.stringify({
          ok: false,
          path: abs,
          error: "old_string matches multiple times. Add surrounding context to make it unique.",
          match_count: attempt.ranges.length,
          diagnostic: buildMultipleMatchesDiagnostic(raw, attempt.ranges),
        });
      }
      let replacement = replacementText;
      if (attempt.crlfAdjusted) {
        const eol = dominantEol(raw);
        if (eol) replacement = conformEol(replacement, eol);
      }
      let next = raw;
      for (const { start, end } of [...attempt.ranges].reverse()) {
        next = next.slice(0, start) + replacement + next.slice(end);
      }
      await withFsDeadline("file_edit", abs, () => fs.writeFile(abs, next, "utf8"));
      return JSON.stringify({
        ok: true,
        path: abs,
        bytes_before: Buffer.byteLength(raw, "utf8"),
        bytes_after: Buffer.byteLength(next, "utf8"),
        replacements: attempt.ranges.length,
        matched_strategy: attempt.usedStrategy,
        eol_normalized: attempt.crlfAdjusted,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    } finally {
      if (handle) {
        try { await withFsDeadline("file_edit.close", abs, () => handle!.close()); } catch { /* preserve the edit result */ }
      }
    }
  },
  {
    name: "file_edit",
    description:
      "Edit a UTF-8 text file in one of two modes: replacement mode uses old_string/new_string and requires one match by default (set replace_all=true for every non-overlapping match); chunk mode uses content plus offset_bytes, starting at 0 and continuing with the returned next_offset for large files. Do not mix modes. Use file_multi_edit for several different replacements in one file.",
    schema: editSchema,
  },
);

// --- move / rename ------------------------------------------------------

const moveSchema = z.object({
  source: z.string().describe("Existing file or directory path. Absolute or ~/foo; bare relative paths resolve against HOME."),
  destination: z.string().describe("New path (absolute or ~/foo; bare relative resolves against HOME). If it ends with a separator or is an existing directory, source is moved into it preserving its basename."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Allow replacing an existing destination file (default false). Existing directories are never overwritten."),
  create_dirs: z
    .boolean()
    .optional()
    .describe("Create missing parent directories of the destination (default true)."),
});

export const fileMoveTool = tool(
  async ({ source, destination, overwrite, create_dirs }, config?: ToolConfig) => {
    let srcAbs = source;
    let dstAbs = destination;
    try {
      const { resolve } = pathResolverFor(config);
      srcAbs = resolve(source);
      dstAbs = resolve(destination);
      assertSafePath(srcAbs, "write");
      assertSafePath(dstAbs, "write");
      const srcStat = await withFsDeadline("file_move.stat", srcAbs, () => fs.stat(srcAbs));
      // If destination is an existing directory, move source INTO it
      // preserving its basename — matches `mv src dir/` semantics.
      let dstStat: import("node:fs").Stats | null = null;
      try {
        dstStat = await withFsDeadline("file_move.stat", dstAbs, () => fs.stat(dstAbs));
      } catch {
        // dst missing — fine
      }
      if (dstStat?.isDirectory()) {
        dstAbs = path.join(dstAbs, path.basename(srcAbs));
        try {
          dstStat = await withFsDeadline("file_move.stat", dstAbs, () => fs.stat(dstAbs));
        } catch {
          dstStat = null;
        }
      }
      if (dstStat) {
        if (dstStat.isDirectory()) {
          return JSON.stringify({
            ok: false,
            source: srcAbs,
            destination: dstAbs,
            error: "destination is an existing directory; refusing to overwrite",
          });
        }
        if (!overwrite) {
          return JSON.stringify({
            ok: false,
            source: srcAbs,
            destination: dstAbs,
            error: "destination exists. Pass overwrite=true to replace it.",
          });
        }
      }
      if (create_dirs !== false) {
        await withFsDeadline("file_move.mkdir", path.dirname(dstAbs), () => fs.mkdir(path.dirname(dstAbs), { recursive: true }));
      }
      await withFsDeadline("file_move", srcAbs, () => fs.rename(srcAbs, dstAbs));
      return JSON.stringify({
        ok: true,
        source: srcAbs,
        destination: dstAbs,
        kind: srcStat.isDirectory() ? "directory" : "file",
      });
    } catch (err) {
      // Cross-device rename fails with EXDEV on Linux/macOS. Fall back to
      // copy+unlink so the agent doesn't need to know about device boundaries.
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EXDEV") {
        try {
          await withFsDeadline("file_move.cp", dstAbs, () => fs.cp(srcAbs, dstAbs, { recursive: true, force: overwrite === true, errorOnExist: !overwrite }));
          await withFsDeadline("file_move.rm", srcAbs, () => fs.rm(srcAbs, { recursive: true, force: true }));
          return JSON.stringify({ ok: true, source: srcAbs, destination: dstAbs, cross_device: true });
        } catch (err2) {
          return JSON.stringify({ ok: false, source: srcAbs, destination: dstAbs, error: (err2 as Error).message });
        }
      }
      return JSON.stringify({ ok: false, source: srcAbs, destination: dstAbs, error: (err as Error).message });
    }
  },
  {
    name: "file_move",
    description:
      "Move or rename a file or directory. If destination is an existing directory, source is moved into it. Handles cross-device moves via copy+remove fallback.",
    schema: moveSchema,
  },
);

// --- list ---------------------------------------------------------------

// Directories that almost never contain anything the agent wants to
// see in an exploration listing. Mirrors the file_grep / file_glob
// skip set so depth-mode is consistent with search.
const LIST_DEFAULT_EXCLUDE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "coverage", ".turbo", ".cache", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".idea", ".vscode",
  "target", "vendor",
]);

const listSchema = z.object({
  path: z.string().describe("Directory path. Absolute or ~/foo; bare relative paths resolve against HOME."),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Cap on returned entries (default 200, max 500)."),
  include_hidden: z
    .boolean()
    .optional()
    .describe("Include dot-prefixed entries (default false)"),
  pattern: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring filter applied to the basename"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Recursion depth (default 1 = current directory only, max 4). Use 2-3 for first-look repo exploration to avoid round-tripping for every subdirectory. Always skips node_modules/.git/dist/build/.next/coverage/.venv/__pycache__/target/vendor regardless."),
});

type ListEntry = { path: string; kind: "file" | "directory" | "other"; size?: number; depth?: number };

// Walks the readdir result applying include_hidden / pattern filters and
// returns the kept entries plus whether we hit the cap. When `maxDepth`
// is > 1 it recurses into subdirectories (skipping the LIST_DEFAULT_EXCLUDE
// noise dirs) so the agent can map a subtree in one call.
async function buildListEntries(
  abs: string,
  items: import("node:fs").Dirent[],
  cap: number,
  includeHidden: boolean | undefined,
  filter: string | null,
  maxDepth: number = 1,
  currentDepth: number = 1,
): Promise<{ entries: ListEntry[]; truncated: boolean }> {
  const entries: ListEntry[] = [];
  let truncated = false;
  for (const it of items) {
    if (entries.length >= cap) { truncated = true; break; }
    if (!includeHidden && it.name.startsWith(".")) continue;
    const full = path.join(abs, it.name);
    const isDir = it.isDirectory();
    const kind: ListEntry["kind"] = isDir ? "directory" : it.isFile() ? "file" : "other";
    // Filter applies to leaves; directories are always kept when
    // recursing so the agent can see the tree structure even if no
    // child basename matches.
    const passesFilter = !filter || it.name.toLowerCase().includes(filter);
    if (!isDir && !passesFilter) continue;
    let size: number | undefined;
    if (kind === "file") {
      try {
        const st = await withFsDeadline("file_list.stat", full, () => fs.stat(full));
        size = st.size;
      } catch { /* ignore stat failures */ }
    }
    // Only emit the directory entry itself when it passes the filter
    // or we're at depth 1 (matches the non-recursive shape).
    if (!isDir || passesFilter || currentDepth === 1) {
      entries.push({ path: full, kind, size, depth: maxDepth > 1 ? currentDepth : undefined });
    }
    if (isDir && currentDepth < maxDepth && !LIST_DEFAULT_EXCLUDE.has(it.name)) {
      let childItems: import("node:fs").Dirent[];
      try {
        childItems = await withFsDeadline("file_list.recurse", full, () => fs.readdir(full, { withFileTypes: true }));
      } catch {
        continue;
      }
      childItems.sort((a, b) => a.name.localeCompare(b.name));
      const remainingCap = cap - entries.length;
      if (remainingCap <= 0) { truncated = true; break; }
      const child = await buildListEntries(
        full, childItems, remainingCap, includeHidden, filter, maxDepth, currentDepth + 1,
      );
      entries.push(...child.entries);
      if (child.truncated) { truncated = true; break; }
    }
  }
  return { entries, truncated };
}

// Build the payload, then enforce a hard JSON byte cap. If the entry list
// itself is too large (e.g. extremely long filenames), drop entries from
// the tail until we fit so the LLM never gets a result that blows past
// its prompt budget.
function buildListPayload(
  abs: string,
  entries: ListEntry[],
  truncated: boolean,
  filters: { include_hidden: boolean; pattern: string | null; max_entries: number; depth: number },
): string {
  const reason = (droppedForSize: number) => droppedForSize > 0 ? "json_size_cap" : truncated ? "entry_cap" : undefined;
  const build = (es: ListEntry[], droppedForSize: number) => JSON.stringify({
    ok: true,
    path: abs,
    entries: es,
    count: es.length,
    total_in_dir_after_filters: entries.length,
    truncated: truncated || droppedForSize > 0,
    truncated_hint: (truncated || droppedForSize > 0)
      ? "Result truncated. Lower max_entries, add a `pattern` filter, or descend into a more specific subdirectory."
      : undefined,
    truncated_reason: reason(droppedForSize),
    dropped_for_size: droppedForSize > 0 ? droppedForSize : undefined,
    filters,
  });
  let payload = build(entries, 0);
  if (payload.length <= MAX_LIST_JSON_BYTES) return payload;
  // Binary-trim entries from the tail until we fit.
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (build(entries.slice(0, mid), entries.length - mid).length <= MAX_LIST_JSON_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return build(entries.slice(0, lo), entries.length - lo);
}

export const fileListTool = tool(
  async ({ path: dirPath, max_entries, include_hidden, pattern, depth }, config?: ToolConfig) => {
    let abs = dirPath;
    try {
      abs = pathResolverFor(config).resolve(dirPath);
      assertSafePath(abs, "read");
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
    const cap = max_entries ?? 200;
    const filter = pattern?.toLowerCase() ?? null;
    const maxDepth = depth ?? 1;
    try {
      let items: import("node:fs").Dirent[];
      try {
        items = await withFsDeadline("file_list", abs, () => fs.readdir(abs, { withFileTypes: true }));
      } catch (err) {
        return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      const { entries, truncated } = await buildListEntries(abs, items, cap, include_hidden, filter, maxDepth);
      return buildListPayload(abs, entries, truncated, {
        include_hidden: !!include_hidden,
        pattern: pattern ?? null,
        max_entries: cap,
        depth: maxDepth,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_list",
    description:
      "List a directory's entries. Default depth=1 (non-recursive). Pass depth=2-4 to map a subtree in one call (skips node_modules/.git/dist/build/.next/coverage/.venv/__pycache__/target/vendor automatically). Hidden (dot) entries are skipped unless include_hidden=true. Optional `pattern` substring filter on basenames. Default cap 200 entries (max 500); the JSON result is hard-capped at ~24 KB and excess entries are dropped with a hint.",
    schema: listSchema,
  },
);

// --- mkdir --------------------------------------------------------------

const mkdirSchema = z.object({
  path: z.string().describe("Directory path to create. Absolute or ~/foo; bare relative paths resolve against HOME."),
  recursive: z.boolean().optional().describe("Create parent directories as needed (default true)"),
});

export const fileMkdirTool = tool(
  async ({ path: dirPath, recursive }, config?: ToolConfig) => {
    let abs = dirPath;
    try {
      abs = pathResolverFor(config).resolve(dirPath);
      assertSafePath(abs, "write");
      await withFsDeadline("file_mkdir", abs, () => fs.mkdir(abs, { recursive: recursive !== false }));
      return JSON.stringify({ ok: true, path: abs });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_mkdir",
    description: "Create a directory. Creates parents by default.",
    schema: mkdirSchema,
  },
);

// --- delete -------------------------------------------------------------

const deleteSchema = z.object({
  path: z.string().describe("File or directory path to remove. Absolute or ~/foo; bare relative paths resolve against HOME."),
  recursive: z
    .boolean()
    .optional()
    .describe("Required to delete a non-empty directory (default false)"),
});

export const fileDeleteTool = tool(
  async ({ path: targetPath, recursive }, config?: ToolConfig) => {
    let abs = targetPath;
    try {
      abs = pathResolverFor(config).resolve(targetPath);
      assertSafePath(abs, "write");
      const st = await withFsDeadline("file_delete.stat", abs, () => fs.stat(abs));
      if (st.isDirectory()) {
        if (!recursive) {
          // Try non-recursive rmdir first — succeeds only if empty.
          try {
            await withFsDeadline("file_delete.rmdir", abs, () => fs.rmdir(abs));
            return JSON.stringify({ ok: true, path: abs, kind: "directory", removed: "empty" });
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOTEMPTY") {
              return JSON.stringify({
                ok: false,
                path: abs,
                error: "directory is not empty. Pass recursive=true to delete its contents.",
              });
            }
            throw err;
          }
        }
        await withFsDeadline("file_delete.rm", abs, () => fs.rm(abs, { recursive: true, force: false }));
        return JSON.stringify({ ok: true, path: abs, kind: "directory", removed: "recursive" });
      }
      await withFsDeadline("file_delete", abs, () => fs.unlink(abs));
      return JSON.stringify({ ok: true, path: abs, kind: "file" });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_delete",
    description:
      "Delete a file or directory. Non-empty directories require recursive=true. Symlinks are not followed.",
    schema: deleteSchema,
  },
);

// --- copy ---------------------------------------------------------------

const copySchema = z.object({
  source: z.string().describe("Existing file or directory path. Absolute or ~/foo; bare relative paths resolve against HOME."),
  destination: z.string().describe("New path (absolute or ~/foo; bare relative resolves against HOME). If it ends with a separator or is an existing directory, source is copied into it preserving its basename."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing destination (default false)"),
  recursive: z.boolean().optional().describe("Recurse when copying a directory (default true)"),
});

export const fileCopyTool = tool(
  async ({ source, destination, overwrite, recursive }, config?: ToolConfig) => {
    let srcAbs = source;
    let dstAbs = destination;
    try {
      const { resolve } = pathResolverFor(config);
      srcAbs = resolve(source);
      dstAbs = resolve(destination);
      assertSafePath(srcAbs, "read");
      assertSafePath(dstAbs, "write");
      const srcStat = await withFsDeadline("file_copy.stat", srcAbs, () => fs.stat(srcAbs));
      let dstStat: import("node:fs").Stats | null = null;
      try {
        dstStat = await withFsDeadline("file_copy.stat", dstAbs, () => fs.stat(dstAbs));
      } catch {
        // missing
      }
      if (dstStat?.isDirectory()) {
        dstAbs = path.join(dstAbs, path.basename(srcAbs));
        try {
          dstStat = await withFsDeadline("file_copy.stat", dstAbs, () => fs.stat(dstAbs));
        } catch {
          dstStat = null;
        }
      }
      if (dstStat && !overwrite) {
        return JSON.stringify({
          ok: false,
          source: srcAbs,
          destination: dstAbs,
          error: "destination exists. Pass overwrite=true to replace it.",
        });
      }
      await withFsDeadline("file_copy.mkdir", path.dirname(dstAbs), () => fs.mkdir(path.dirname(dstAbs), { recursive: true }));
      if (srcStat.isDirectory()) {
        if (recursive === false) {
          return JSON.stringify({
            ok: false,
            source: srcAbs,
            error: "source is a directory but recursive=false",
          });
        }
        await withFsDeadline("file_copy.cp", dstAbs, () => fs.cp(srcAbs, dstAbs, { recursive: true, force: overwrite === true, errorOnExist: !overwrite }));
      } else {
        await withFsDeadline("file_copy", dstAbs, () => fs.copyFile(srcAbs, dstAbs));
      }
      return JSON.stringify({
        ok: true,
        source: srcAbs,
        destination: dstAbs,
        kind: srcStat.isDirectory() ? "directory" : "file",
      });
    } catch (err) {
      return JSON.stringify({ ok: false, source: srcAbs, destination: dstAbs, error: (err as Error).message });
    }
  },
  {
    name: "file_copy",
    description:
      "Copy a file or directory. If destination is an existing directory, source is copied into it. Directories require recursive=true (default).",
    schema: copySchema,
  },
);

// --- stat ---------------------------------------------------------------

const statSchema = z.object({
  path: z.string().describe("File or directory path. Absolute or ~/foo; bare relative paths resolve against HOME."),
});

export const fileStatTool = tool(
  async ({ path: targetPath }, config?: ToolConfig) => {
    let abs = targetPath;
    try {
      abs = pathResolverFor(config).resolve(targetPath);
      assertSafePath(abs, "read");
      const st = await withFsDeadline("file_stat", abs, () => fs.stat(abs));
      return JSON.stringify({
        ok: true,
        path: abs,
        exists: true,
        kind: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
        size: st.size,
        modified_ms: st.mtimeMs,
        created_ms: st.birthtimeMs,
        mode: st.mode,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return JSON.stringify({ ok: true, path: abs, exists: false });
      }
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_stat",
    description: "Check whether a path exists and return its kind, size, and timestamps.",
    schema: statSchema,
  },
);

registerLangChainPackage({
  category: "Files",
  tools: {
    read: [fileReadTool, fileListTool, fileStatTool],
    write: [fileWriteTool, fileEditTool, fileMoveTool, fileCopyTool, fileDeleteTool, fileMkdirTool],
  },
});
