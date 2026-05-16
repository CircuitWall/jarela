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
