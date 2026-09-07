import { z } from "zod";
import type { MemoryPolicy } from "@/lib/stores/app-settings";

export const MEMORY_KINDS = [
  "preference", "fact", "decision", "constraint", "project_context", "contact", "task",
] as const;
export const MEMORY_CONFIDENCE = ["explicit", "inferred", "verified"] as const;
export const MEMORY_SOURCES = ["conversation", "tool_result", "user_profile", "import"] as const;

export const StructuredMemoryRecordSchema = z.object({
  version: z.literal(1),
  kind: z.enum(MEMORY_KINDS),
  subject: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8_000),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).default([]),
  confidence: z.enum(MEMORY_CONFIDENCE),
  source: z.enum(MEMORY_SOURCES),
  observed_at: z.string().datetime().nullable().default(null),
  expires_at: z.string().datetime().nullable().default(null),
}).strict();

export type StructuredMemoryRecord = z.infer<typeof StructuredMemoryRecordSchema>;

export function parseStructuredMemory(value: unknown): StructuredMemoryRecord | null {
  const candidate = typeof value === "string" ? parseJson(value) : value;
  const parsed = StructuredMemoryRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function isStructuredMemoryActive(record: StructuredMemoryRecord, now = Date.now()): boolean {
  return record.expires_at === null || Date.parse(record.expires_at) > now;
}

export function memorySearchText(namespace: string, key: string, value: unknown): string {
  const record = parseStructuredMemory(value);
  if (!record) return `${namespace}/${key}: ${stringifyMemoryValue(value)}`;
  return [
    `${namespace}/${key}`,
    record.kind,
    record.subject,
    record.tags.join(" "),
    record.content,
  ].filter(Boolean).join(": ");
}

export function memoryRecallText(namespace: string, key: string, value: unknown): string | null {
  const record = parseStructuredMemory(value);
  if (!record) return stringifyMemoryValue(value);
  if (!isStructuredMemoryActive(record)) return null;
  const meta = [record.kind, record.confidence, record.observed_at ? `observed: ${record.observed_at.slice(0, 10)}` : "", record.tags.length ? `tags: ${record.tags.join(", ")}` : ""]
    .filter(Boolean)
    .join(" | ");
  return `${record.subject}: ${record.content}${meta ? ` (${meta})` : ""}`;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function stringifyMemoryValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function isStructuredMemoryEligible(record: StructuredMemoryRecord, policy: MemoryPolicy): boolean {
  if (!isStructuredMemoryActive(record)) return false;
  if (policy !== "important") return true;
  return record.confidence !== "inferred"
    && record.kind !== "contact"
    && record.kind !== "task";
}