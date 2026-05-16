import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Dedicated file tools. Agents previously had to drive every edit through
// `local_exec` / `shell_exec`, which works for "create a new file with this
// content" (echo / Set-Content) but is hostile to in-place edits: quoting
// rules differ per shell, multi-line strings break under cmd.exe, and a
// read-modify-write cycle needs two shell calls plus careful diff-by-hand.
// These tools give agents a first-class file write + targeted edit surface.

const MAX_READ_BYTES = 512_000;
const MAX_WRITE_BYTES = 2_000_000;

function clip(text: string, max: number): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

// Resolve agent-supplied paths against the USER'S HOME directory, not
// process.cwd(). In production cwd is the LangGUI install dir
// (%LOCALAPPDATA%\Programs\LangGUI) — if the agent writes "notes.txt"
// expecting it to land somewhere visible, it lands buried in the install
// tree and the user concludes the tool didn't run. Home is the natural
// default for an "assistant on my computer". Absolute paths and ~/ paths
// are honored verbatim.
function resolvePath(p: string): string {
  if (!p.trim()) throw new Error("path is required");
  let s = p.trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(os.homedir(), s.slice(2));
    return path.resolve(s);
  }
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(os.homedir(), s);
}

// --- read ---------------------------------------------------------------

const readSchema = z.object({
  path: z.string().describe("File path. Absolute (C:\\... or /...) or ~/foo recommended; bare relative paths resolve against the user's HOME directory."),
  start_line: z.number().int().min(1).optional().describe("1-based first line to include"),
  end_line: z.number().int().min(1).optional().describe("1-based last line to include (inclusive)"),
});

export const fileReadTool = tool(
  async ({ path: filePath, start_line, end_line }) => {
    const abs = resolvePath(filePath);
    try {
      const raw = await fs.readFile(abs, "utf8");
      let content = raw;
      let lineRange: { start: number; end: number } | null = null;
      if (start_line || end_line) {
        const lines = raw.split(/\r?\n/);
        const s = Math.max(1, start_line ?? 1);
        const e = Math.min(lines.length, end_line ?? lines.length);
        content = lines.slice(s - 1, e).join("\n");
        lineRange = { start: s, end: e };
      }
      const clipped = clip(content, MAX_READ_BYTES);
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
      "Read a UTF-8 text file. Optional 1-based start_line/end_line slice. Output clipped at 512 KB.",
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
  async ({ path: filePath, content, create_dirs }) => {
    const abs = resolvePath(filePath);
    if (content.length > MAX_WRITE_BYTES) {
      return JSON.stringify({ ok: false, path: abs, error: `content exceeds ${MAX_WRITE_BYTES} bytes` });
    }
    try {
      if (create_dirs !== false) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
      }
      let existed = true;
      try {
        await fs.access(abs);
      } catch {
        existed = false;
      }
      await fs.writeFile(abs, content, "utf8");
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
  async ({ path: filePath, old_string, new_string }) => {
    const abs = resolvePath(filePath);
    try {
      const raw = await fs.readFile(abs, "utf8");
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
      await fs.writeFile(abs, next, "utf8");
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
  async ({ source, destination, overwrite, create_dirs }) => {
    const srcAbs = resolvePath(source);
    let dstAbs = resolvePath(destination);
    try {
      const srcStat = await fs.stat(srcAbs);
      // If destination is an existing directory, move source INTO it
      // preserving its basename — matches `mv src dir/` semantics.
      let dstStat: import("fs").Stats | null = null;
      try {
        dstStat = await fs.stat(dstAbs);
      } catch {
        // dst missing — fine
      }
      if (dstStat?.isDirectory()) {
        dstAbs = path.join(dstAbs, path.basename(srcAbs));
        try {
          dstStat = await fs.stat(dstAbs);
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
        await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      }
      await fs.rename(srcAbs, dstAbs);
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
          await fs.cp(srcAbs, dstAbs, { recursive: true, force: overwrite === true, errorOnExist: !overwrite });
          await fs.rm(srcAbs, { recursive: true, force: true });
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

// Common directories that almost always represent noise for an agent
// browsing a workspace. Skipping them by default lets recursive listings
// of a real project return useful results instead of burning the entry
// budget on node_modules. Override with include_ignored=true.
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", ".pnpm-store",
  "dist", "build", "out", "coverage", ".venv", "venv", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".idea", ".vscode-test",
]);

const listSchema = z.object({
  path: z.string().describe("Directory path. Absolute or ~/foo; bare relative paths resolve against HOME."),
  recursive: z.boolean().optional().describe("Recurse into subdirectories (default false)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .optional()
    .describe("Cap on returned entries (default 5000, max 50000)"),
  include_hidden: z
    .boolean()
    .optional()
    .describe("Include dot-prefixed entries (default false)"),
  include_ignored: z
    .boolean()
    .optional()
    .describe("Recurse into common noise dirs like node_modules, .git, dist (default false)"),
  pattern: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring filter applied to the basename"),
});

export const fileListTool = tool(
  async ({ path: dirPath, recursive, max_entries, include_hidden, include_ignored, pattern }) => {
    const abs = resolvePath(dirPath);
    const cap = max_entries ?? 5000;
    const filter = pattern?.toLowerCase() ?? null;
    const entries: Array<{ path: string; kind: "file" | "directory" | "other"; size?: number }> = [];
    let truncated = false;
    let skippedDirs = 0;
    async function walk(dir: string): Promise<void> {
      let items: import("fs").Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // Unreadable subdir (perm denied, symlink loop, etc.) — skip silently.
        return;
      }
      // Stable order so paginated / repeated calls behave predictably.
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of items) {
        if (entries.length >= cap) {
          truncated = true;
          return;
        }
        if (!include_hidden && it.name.startsWith(".")) continue;
        const full = path.join(dir, it.name);
        const kind: "file" | "directory" | "other" = it.isDirectory()
          ? "directory"
          : it.isFile()
            ? "file"
            : "other";
        const matches = filter ? it.name.toLowerCase().includes(filter) : true;
        if (matches) {
          let size: number | undefined;
          if (kind === "file") {
            try {
              const st = await fs.stat(full);
              size = st.size;
            } catch {
              // ignore
            }
          }
          entries.push({ path: full, kind, size });
        }
        if (recursive && kind === "directory") {
          if (!include_ignored && DEFAULT_IGNORE_DIRS.has(it.name)) {
            skippedDirs += 1;
            continue;
          }
          await walk(full);
        }
      }
    }
    try {
      await walk(abs);
      return JSON.stringify({
        ok: true,
        path: abs,
        entries,
        count: entries.length,
        truncated,
        truncated_hint: truncated
          ? "Result hit max_entries. Re-call with a narrower `path`, set `recursive=false`, add a `pattern` filter, or raise `max_entries` (up to 50000)."
          : undefined,
        skipped_ignored_dirs: skippedDirs > 0 ? skippedDirs : undefined,
        filters: {
          recursive: !!recursive,
          include_hidden: !!include_hidden,
          include_ignored: !!include_ignored,
          pattern: pattern ?? null,
          max_entries: cap,
        },
      });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_list",
    description:
      "List directory entries. Non-recursive by default. Hidden (dot) entries and common noise dirs (node_modules, .git, dist, .next, venv, __pycache__, …) are skipped unless include_hidden / include_ignored are set. Optional substring `pattern` filter on basenames. Default cap 5000 entries (max 50000); if truncated the result includes a hint.",
    schema: listSchema,
  },
);

// --- mkdir --------------------------------------------------------------

const mkdirSchema = z.object({
  path: z.string().describe("Directory path to create. Absolute or ~/foo; bare relative paths resolve against HOME."),
  recursive: z.boolean().optional().describe("Create parent directories as needed (default true)"),
});

export const fileMkdirTool = tool(
  async ({ path: dirPath, recursive }) => {
    const abs = resolvePath(dirPath);
    try {
      await fs.mkdir(abs, { recursive: recursive !== false });
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
  async ({ path: targetPath, recursive }) => {
    const abs = resolvePath(targetPath);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        if (!recursive) {
          // Try non-recursive rmdir first — succeeds only if empty.
          try {
            await fs.rmdir(abs);
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
        await fs.rm(abs, { recursive: true, force: false });
        return JSON.stringify({ ok: true, path: abs, kind: "directory", removed: "recursive" });
      }
      await fs.unlink(abs);
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
  async ({ source, destination, overwrite, recursive }) => {
    const srcAbs = resolvePath(source);
    let dstAbs = resolvePath(destination);
    try {
      const srcStat = await fs.stat(srcAbs);
      let dstStat: import("fs").Stats | null = null;
      try {
        dstStat = await fs.stat(dstAbs);
      } catch {
        // missing
      }
      if (dstStat?.isDirectory()) {
        dstAbs = path.join(dstAbs, path.basename(srcAbs));
        try {
          dstStat = await fs.stat(dstAbs);
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
      await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      if (srcStat.isDirectory()) {
        if (recursive === false) {
          return JSON.stringify({
            ok: false,
            source: srcAbs,
            error: "source is a directory but recursive=false",
          });
        }
        await fs.cp(srcAbs, dstAbs, { recursive: true, force: overwrite === true, errorOnExist: !overwrite });
      } else {
        await fs.copyFile(srcAbs, dstAbs);
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
  async ({ path: targetPath }) => {
    const abs = resolvePath(targetPath);
    try {
      const st = await fs.stat(abs);
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
