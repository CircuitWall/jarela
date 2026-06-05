import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import { checkFsAllowed, resolveSafetyMode } from "./safety";
import { getConfig } from "@/lib/env/config";
import { currentWorkspace, type ToolConfig } from "./workspace-context";

// Dedicated file tools. Agents previously had to drive every edit through
// `local_exec` / `shell_exec`, which works for "create a new file with this
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
  const a = path.resolve(abs);
  const p = path.resolve(parent);
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
      return JSON.stringify({
        ok: true,
        path: abs,
        content: clipped.value,
        truncated: clipped.truncated,
        line_range: lineRange,
        total_lines: raw.split(/\r?\n/).length,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_read",
    description:
      "Read a UTF-8 text file. Optional 1-based start_line/end_line slice. Output clipped at 64 KB — for large files always pass a line range and walk in chunks.",
    schema: readSchema,
  },
);

// --- write --------------------------------------------------------------

const writeSchema = z.object({
  path: z.string().describe("File path. Absolute (C:\\... or /...) or ~/foo recommended; bare relative paths resolve against the user's HOME directory."),
  content: z.string().describe("Full file content. Overwrites the file if it exists."),
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
      if (content.length > cap) {
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
      "Create or fully overwrite a UTF-8 text file. Parent directories are created by default. Use file_edit for targeted in-place changes.",
    schema: writeSchema,
  },
);

// --- edit ---------------------------------------------------------------

const editSchema = z.object({
  path: z.string().describe("File path. Absolute (C:\\... or /...) or ~/foo recommended; bare relative paths resolve against the user's HOME directory."),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact literal substring to replace. Must appear EXACTLY ONCE in the file (include surrounding context to disambiguate).",
    ),
  new_string: z.string().describe("Replacement text. May be empty to delete."),
});

export const fileEditTool = tool(
  async ({ path: filePath, old_string, new_string }, config?: ToolConfig) => {
    let abs = filePath;
    try {
      abs = pathResolverFor(config).resolve(filePath);
      assertSafePath(abs, "write");
      const raw = await withFsDeadline("file_edit.read", abs, () => fs.readFile(abs, "utf8"));
      const first = raw.indexOf(old_string);
      if (first === -1) {
        return JSON.stringify({
          ok: false,
          path: abs,
          error: "old_string not found. Re-read the file and try with the exact current content.",
        });
      }
      const second = raw.indexOf(old_string, first + old_string.length);
      if (second !== -1) {
        return JSON.stringify({
          ok: false,
          path: abs,
          error: "old_string matches multiple times. Add surrounding context to make it unique.",
          match_count: raw.split(old_string).length - 1,
        });
      }
      const next = raw.slice(0, first) + new_string + raw.slice(first + old_string.length);
      await withFsDeadline("file_edit", abs, () => fs.writeFile(abs, next, "utf8"));
      return JSON.stringify({
        ok: true,
        path: abs,
        bytes_before: Buffer.byteLength(raw, "utf8"),
        bytes_after: Buffer.byteLength(next, "utf8"),
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_edit",
    description:
      "Replace a single exact-match substring inside a file. The old_string must appear exactly once — include enough surrounding context to disambiguate. Use this for in-place edits instead of shell heredocs.",
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

const listSchema = z.object({
  path: z.string().describe("Directory path. Absolute or ~/foo; bare relative paths resolve against HOME."),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Cap on returned entries (default 200, max 500). Listings are non-recursive — to explore subtrees, call file_list once per directory."),
  include_hidden: z
    .boolean()
    .optional()
    .describe("Include dot-prefixed entries (default false)"),
  pattern: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring filter applied to the basename"),
});

export const fileListTool = tool(
  async ({ path: dirPath, max_entries, include_hidden, pattern }, config?: ToolConfig) => {
    let abs = dirPath;
    try {
      abs = pathResolverFor(config).resolve(dirPath);
      assertSafePath(abs, "read");
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
    const cap = max_entries ?? 200;
    const filter = pattern?.toLowerCase() ?? null;
    const entries: Array<{ path: string; kind: "file" | "directory" | "other"; size?: number }> = [];
    let truncated = false;
    try {
      let items: import("node:fs").Dirent[];
      try {
        items = await withFsDeadline("file_list", abs, () => fs.readdir(abs, { withFileTypes: true }));
      } catch (err) {
        return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of items) {
        if (entries.length >= cap) {
          truncated = true;
          break;
        }
        if (!include_hidden && it.name.startsWith(".")) continue;
        if (filter && !it.name.toLowerCase().includes(filter)) continue;
        const full = path.join(abs, it.name);
        const kind: "file" | "directory" | "other" = it.isDirectory()
          ? "directory"
          : it.isFile()
            ? "file"
            : "other";
        let size: number | undefined;
        if (kind === "file") {
          try {
            const st = await withFsDeadline("file_list.stat", full, () => fs.stat(full));
            size = st.size;
          } catch {
            // ignore
          }
        }
        entries.push({ path: full, kind, size });
      }
      // Build the payload, then enforce a hard JSON byte cap. If the entry
      // list itself is too large (e.g. extremely long filenames), drop
      // entries from the tail until we fit so the LLM never gets a result
      // that blows past its prompt budget.
      const build = (es: typeof entries, droppedForSize: number) => JSON.stringify({
        ok: true,
        path: abs,
        entries: es,
        count: es.length,
        total_in_dir_after_filters: entries.length,
        truncated: truncated || droppedForSize > 0,
        truncated_hint: (truncated || droppedForSize > 0)
          ? "Result truncated. Lower max_entries, add a `pattern` filter, or descend into a more specific subdirectory."
          : undefined,
        dropped_for_size: droppedForSize > 0 ? droppedForSize : undefined,
        filters: {
          include_hidden: !!include_hidden,
          pattern: pattern ?? null,
          max_entries: cap,
        },
      });
      let payload = build(entries, 0);
      if (payload.length > MAX_LIST_JSON_BYTES) {
        // Binary-trim entries from the tail until we fit.
        let lo = 0, hi = entries.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (build(entries.slice(0, mid), entries.length - mid).length <= MAX_LIST_JSON_BYTES) lo = mid;
          else hi = mid - 1;
        }
        payload = build(entries.slice(0, lo), entries.length - lo);
      }
      return payload;
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_list",
    description:
      "List one directory's entries (NON-RECURSIVE). To explore a subtree, call file_list once per directory and decide what to descend into based on the result — do NOT try to list everything at once. Hidden (dot) entries are skipped unless include_hidden=true. Optional `pattern` substring filter on basenames. Default cap 200 entries (max 500); the JSON result is hard-capped at ~24 KB and excess entries are dropped with a hint.",
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

registerTools("Files", "read", [fileReadTool, fileListTool, fileStatTool]);
registerTools("Files", "write", [
  fileWriteTool, fileEditTool, fileMoveTool, fileCopyTool, fileDeleteTool, fileMkdirTool,
]);
