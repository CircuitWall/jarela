import { promises as fs } from "fs";
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

function resolvePath(p: string): string {
  if (!p.trim()) throw new Error("path is required");
  return path.resolve(p);
}

// --- read ---------------------------------------------------------------

const readSchema = z.object({
  path: z.string().describe("Absolute or cwd-relative file path"),
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
  path: z.string().describe("Absolute or cwd-relative file path"),
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
  path: z.string().describe("Absolute or cwd-relative file path"),
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
  source: z.string().describe("Existing file or directory path"),
  destination: z.string().describe("New path. If it ends with a separator or is an existing directory, source is moved into it preserving its basename."),
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

const listSchema = z.object({
  path: z.string().describe("Directory path to list"),
  recursive: z.boolean().optional().describe("Recurse into subdirectories (default false)"),
  max_entries: z.number().int().min(1).max(2000).optional().describe("Cap on returned entries (default 500)"),
});

export const fileListTool = tool(
  async ({ path: dirPath, recursive, max_entries }) => {
    const abs = resolvePath(dirPath);
    const cap = max_entries ?? 500;
    const entries: Array<{ path: string; kind: "file" | "directory" | "other"; size?: number }> = [];
    let truncated = false;
    async function walk(dir: string): Promise<void> {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const it of items) {
        if (entries.length >= cap) {
          truncated = true;
          return;
        }
        const full = path.join(dir, it.name);
        const kind: "file" | "directory" | "other" = it.isDirectory()
          ? "directory"
          : it.isFile()
            ? "file"
            : "other";
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
        if (recursive && kind === "directory") await walk(full);
      }
    }
    try {
      await walk(abs);
      return JSON.stringify({ ok: true, path: abs, entries, truncated });
    } catch (err) {
      return JSON.stringify({ ok: false, path: abs, error: (err as Error).message });
    }
  },
  {
    name: "file_list",
    description: "List directory entries (non-recursive by default). Returns path, kind, and size for files.",
    schema: listSchema,
  },
);

// --- mkdir --------------------------------------------------------------

const mkdirSchema = z.object({
  path: z.string().describe("Directory path to create"),
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
