import { promises as fsp } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getConfig } from "@/lib/env/config";
import { errorMessage } from "@/lib/utils/error";
import { utf8ByteWindow } from "@/lib/utils/text";

const DEFAULT_PREVIEW_BYTES = 4 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const JSON_ARRAY_PREVIEW_ITEMS = 20;
const FILES_ROUTE_PREFIX = "/api/v1/files/";
// One path segment of the files route, stopping before any wrapper the model
// may have copied along with it (`)`, `]`, quote, query, fragment, ...).
const REF_SEGMENT = /^[A-Za-z0-9._%-]+/;
const CONTENT_HASH_NAME = /^[A-F0-9]{64}(?:\.[A-Za-z0-9]+)?$/;

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
  let name = await toStoredName(args.name);
  const abs = fileAbsPath(name);
  if (!abs) {
    return {
      ok: false,
      status: "unknown",
      error:
        `unsafe result_ref name: pass result_ref.name, the bare emitted file name including its extension; ` +
        `the result_ref.uri and absolute path forms are also accepted, but "${args.name}" is neither`,
      name: args.name,
    };
  }
  const requestedOffset = args.offset ?? 0;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
  const requestedLimit = args.limit ?? DEFAULT_PREVIEW_BYTES;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(requestedLimit)))
    : DEFAULT_PREVIEW_BYTES;
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
      const { start, end } = utf8ByteWindow(buf, Math.min(offset, stat.size) - windowStart, limit);
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

// Envelopes publish `uri` (the /api/v1/files route), `name`, and sometimes an
// absolute `path` side by side, so a copied locator can arrive in any of those
// forms. Map each back to the bare stored name; everything else stays as-is and
// fails the isSafeFileName check, which is what keeps path traversal out.
async function toStoredName(raw: unknown): Promise<string> {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  const routeAt = trimmed.indexOf(FILES_ROUTE_PREFIX);
  if (routeAt !== -1) {
    const segment = REF_SEGMENT.exec(trimmed.slice(routeAt + FILES_ROUTE_PREFIX.length))?.[0] ?? "";
    return normalizeStoredName(decodeRefSegment(segment));
  }
  if (/[\\/]/.test(trimmed)) {
    const { FILES_DIR } = await import("@/lib/files");
    const stored = resolve(FILES_DIR);
    const given = resolve(dirname(trimmed));
    const sameDir = process.platform === "win32" ? given.toLowerCase() === stored.toLowerCase() : given === stored;
    if (sameDir) return normalizeStoredName(basename(trimmed));
  }
  return normalizeStoredName(trimmed);
}

function decodeRefSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Stored spill names are `<lowercase sha256>.<ext>`. Fold a copied uppercase
// hash so the reference resolves on case-sensitive file systems too; names that
// are not content-addressed are left untouched.
function normalizeStoredName(name: string): string {
  return CONTENT_HASH_NAME.test(name) ? name.toLowerCase() : name;
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