import { promises as fsp } from "node:fs";
import { getConfig } from "@/lib/env/config";
import { errorMessage } from "@/lib/utils/error";

const DEFAULT_PREVIEW_BYTES = 4 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const JSON_ARRAY_PREVIEW_ITEMS = 20;

export interface ToolResultRef {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
}

export interface ToolResultReferenceEnvelope {
  ok: true;
  tool: string;
  truncated: true;
  bytes: number;
  preview: unknown;
  preview_bytes: number;
  result_ref: ToolResultRef;
  total_count?: number;
  hint: string;
}

export function getToolResultMaxBytes(): number {
  return getConfig().toolResultMaxBytes;
}

export async function postProcessToolResult(toolName: string, result: unknown): Promise<string> {
  const serialized = serializeToolResult(result);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= getToolResultMaxBytes()) return serialized;

  const mimeType = looksLikeJson(serialized) ? "application/json" : "text/plain";
  const buf = Buffer.from(serialized, "utf8");
  const { spillFileBuffer } = await import("@/lib/attachments/spill");
  const ref = await spillFileBuffer(buf, mimeType, `${safeToolName(toolName)}-result.${mimeType === "application/json" ? "json" : "txt"}`);
  const preview = buildPreview(serialized, mimeType);
  const envelope: ToolResultReferenceEnvelope = {
    ok: true,
    tool: toolName,
    truncated: true,
    bytes,
    preview: preview.value,
    preview_bytes: preview.bytes,
    result_ref: {
      uri: `/api/v1/files/${encodeURIComponent(ref.name)}`,
      name: ref.name,
      mimeType,
      size: bytes,
      sha256: ref.sha256,
    },
    hint: `This tool result was shortened. ${toolName === "file_read" ? "Prefer file_grep on the source path to locate relevant lines, then file_read with explicit start_line/end_line; do not reconstruct the whole file from result pages unless the task requires complete inspection. " : ""}Call tool_result_get with result_ref: { name: "${ref.name}" } and a small offset/limit only for the needed slice; stop when sufficient evidence is obtained. Copy the full name including its extension, not sha256. Synchronous spills are not listed by tool_result_list.`,
  };
  if (typeof preview.total_count === "number") envelope.total_count = preview.total_count;
  return JSON.stringify(envelope);
}

export function parseToolResultReferenceEnvelope(value: unknown): ToolResultReferenceEnvelope | null {
  if (!value) return null;
  if (typeof value === "object") return validateToolResultReferenceEnvelope(value);
  if (typeof value !== "string") return null;
  try {
    return validateToolResultReferenceEnvelope(JSON.parse(value));
  } catch {
    return null;
  }
}

function validateToolResultReferenceEnvelope(value: unknown): ToolResultReferenceEnvelope | null {
  const parsed = value as Partial<ToolResultReferenceEnvelope>;
  if (parsed?.ok !== true || parsed.truncated !== true) return null;
  if (!parsed.result_ref || typeof parsed.result_ref.name !== "string") return null;
  if (typeof parsed.bytes !== "number") return null;
  return parsed as ToolResultReferenceEnvelope;
}

export async function readToolResultRef(args: {
  name: string;
  offset?: number;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const { fileAbsPath } = await import("@/lib/files");
  let name = args.name;
  const abs = fileAbsPath(name);
  if (!abs) {
    return { ok: false, status: "unknown", error: "unsafe result_ref name", name: args.name };
  }
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(args.limit ?? DEFAULT_PREVIEW_BYTES)));
  try {
    const resolved = await openToolResultFile(name);
    if ("error" in resolved) return { ok: false, status: "ambiguous", name, error: resolved.error };
    const { file } = resolved;
    name = resolved.name;
    try {
      const stat = await file.stat();
      // Read a few bytes either side so the window can be moved onto UTF-8
      // character boundaries; paging must never split a multi-byte character.
      const windowStart = Math.min(Math.max(0, offset - 3), stat.size);
      const windowLength = Math.max(0, Math.min(stat.size - windowStart, offset - windowStart + limit + 3));
      const buf = Buffer.alloc(windowLength);
      if (windowLength > 0) await file.read(buf, 0, windowLength, windowStart);
      const { start, end } = utf8Window(buf, Math.min(offset, stat.size) - windowStart, limit);
      const actualOffset = windowStart + start;
      const nextOffset = windowStart + end;
      return {
        ok: true,
        status: "done",
        name,
        offset: actualOffset,
        limit,
        bytes: stat.size,
        result: buf.subarray(start, end).toString("utf8"),
        next_offset: nextOffset < stat.size ? nextOffset : null,
        done: nextOffset >= stat.size,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return {
      ok: false,
      status: missing ? "unknown" : "error",
      name: args.name,
      error: missing
        ? "no spilled tool result for that ref (it may have expired or never existed); copy result_ref.name including its extension, not sha256"
        : `could not read spilled tool result: ${errorMessage(error)}`,
    };
  }
}

async function openToolResultFile(name: string): Promise<
  { name: string; file: Awaited<ReturnType<typeof fsp.open>> } | { error: string }
> {
  const { fileAbsPath } = await import("@/lib/files");
  if (!/^[a-f0-9]{64}$/.test(name)) return { name, file: await fsp.open(fileAbsPath(name)!, "r") };
  // Older callers copied the content hash rather than the full result filename.
  const matches: string[] = [];
  for (const extension of ["json", "txt"]) {
    const candidate = `${name}.${extension}`;
    try {
      if ((await fsp.stat(fileAbsPath(candidate)!)).isFile()) matches.push(candidate);
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (matches.length > 1) return { error: "ambiguous content hash; pass the full result_ref.name including its extension" };
  const resolvedName = matches[0] ?? name;
  return { name: resolvedName, file: await fsp.open(fileAbsPath(resolvedName)!, "r") };
}

const isUtf8Continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

// Moves `[start, start + limit)` inside `buf` onto character boundaries: the
// start backs up to its lead byte, and the end backs up so it does not cut a
// character — unless that character alone exceeds `limit`, in which case the
// whole character is returned so paging always makes progress.
function utf8Window(buf: Buffer, start: number, limit: number): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, buf.length));
  while (s > 0 && isUtf8Continuation(buf[s])) s--;
  let e = Math.min(buf.length, s + limit);
  if (e < buf.length && isUtf8Continuation(buf[e])) {
    let lead = e;
    while (lead > s && isUtf8Continuation(buf[lead])) lead--;
    if (lead > s) e = lead;
    else while (e < buf.length && isUtf8Continuation(buf[e])) e++;
  }
  return { start: s, end: e };
}

export function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result) ?? String(result);
}

function looksLikeJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function buildPreview(value: string, mimeType: string): { value: unknown; bytes: number; total_count?: number } {
  if (mimeType === "application/json") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        // Cap by bytes as well as items: a few huge rows must not smuggle the
        // whole result back inline.
        for (let n = Math.min(parsed.length, JSON_ARRAY_PREVIEW_ITEMS); n > 0; n--) {
          const preview = parsed.slice(0, n);
          const bytes = Buffer.byteLength(JSON.stringify(preview));
          if (bytes <= DEFAULT_PREVIEW_BYTES) return { value: preview, bytes, total_count: parsed.length };
        }
        const text = takeUtf8Prefix(value, DEFAULT_PREVIEW_BYTES);
        return { value: text, bytes: Buffer.byteLength(text), total_count: parsed.length };
      }
    } catch {
      // Fall through to byte preview.
    }
  }
  const preview = takeUtf8Prefix(value, DEFAULT_PREVIEW_BYTES);
  return { value: preview, bytes: Buffer.byteLength(preview) };
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(value.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const code = value.charCodeAt(lo - 1);
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo--;
  return value.slice(0, lo);
}

function safeToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "tool";
}