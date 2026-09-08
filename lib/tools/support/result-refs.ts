import { promises as fsp } from "node:fs";

const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
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
  const raw = process.env.JARELA_TOOL_RESULT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_INLINE_BYTES;
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
    hint: `This tool result was shortened. Call tool_result_get with result_ref.name="${ref.name}" and offset/limit to read more.`,
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
  const abs = fileAbsPath(args.name);
  if (!abs) {
    return { ok: false, status: "unknown", error: "unsafe result_ref name", name: args.name };
  }
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(args.limit ?? DEFAULT_PREVIEW_BYTES)));
  let buf: Buffer;
  try {
    const file = await fsp.open(abs, "r");
    try {
      const stat = await file.stat();
      const readLength = Math.max(0, Math.min(limit, stat.size - offset));
      buf = Buffer.alloc(readLength);
      if (readLength > 0) await file.read(buf, 0, readLength, offset);
      const nextOffset = offset + readLength;
      return {
        ok: true,
        status: "done",
        name: args.name,
        offset,
        limit,
        bytes: stat.size,
        result: buf.toString("utf8"),
        next_offset: nextOffset < stat.size ? nextOffset : null,
        done: nextOffset >= stat.size,
      };
    } finally {
      await file.close();
    }
  } catch {
    return {
      ok: false,
      status: "unknown",
      name: args.name,
      error: "no spilled tool result for that ref (it may have expired or never existed)",
    };
  }
}

function serializeToolResult(result: unknown): string {
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
        const preview = parsed.slice(0, JSON_ARRAY_PREVIEW_ITEMS);
        return { value: preview, bytes: Buffer.byteLength(JSON.stringify(preview)), total_count: parsed.length };
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
  return value.slice(0, lo);
}

function safeToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "tool";
}