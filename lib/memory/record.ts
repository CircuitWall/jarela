import { z } from "zod";
import type { MemoryPolicy } from "@/lib/stores/app-settings";

export const MEMORY_KINDS = [
  "preference", "fact", "decision", "constraint", "project_context", "contact", "task",
] as const;
export const MEMORY_CONFIDENCE = ["explicit", "inferred", "verified"] as const;
export const MEMORY_SOURCES = ["conversation", "tool_result", "user_profile", "import"] as const;
export const MEMORY_STATUSES = ["active", "archived"] as const;

// Bump when adding a new structured schema version. Legacy rows are
// upgraded lazily on read (see lib/stores/memory.ts) rather than through
// a database migration — see ADR-0084.
export const CURRENT_STRUCTURED_MEMORY_VERSION = 2 as const;

const sharedCoreFields = {
  kind: z.enum(MEMORY_KINDS),
  subject: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8_000),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).default([]),
  confidence: z.enum(MEMORY_CONFIDENCE),
  source: z.enum(MEMORY_SOURCES),
  observed_at: z.string().datetime().nullable().default(null),
  expires_at: z.string().datetime().nullable().default(null),
};

// v1: the original shipped envelope. Kept only so existing rows still
// parse; every write from here on uses v2.
const StructuredMemoryCoreV1Schema = z.object({
  version: z.literal(1),
  ...sharedCoreFields,
}).strict();

// v2: adds a soft-delete status, a short recall summary, and search
// aliases, in the same JSON value column (no schema migration needed).
const StructuredMemoryCoreV2Schema = z.object({
  version: z.literal(CURRENT_STRUCTURED_MEMORY_VERSION),
  ...sharedCoreFields,
  summary: z.string().trim().max(280).nullable().default(null),
  aliases: z.array(z.string().trim().min(1).max(48)).max(8).default([]),
  status: z.enum(MEMORY_STATUSES).default("active"),
}).strict();

// History entries snapshot only the versioned core fields — never the
// `history` array itself, so revisions can't nest inside one another.
export const StructuredMemoryHistoryEntrySchema = z.object({
  updated_at: z.string().datetime(),
  record: z.union([StructuredMemoryCoreV2Schema, StructuredMemoryCoreV1Schema]),
}).strict();

const StructuredMemoryEnvelopeV1Schema = StructuredMemoryCoreV1Schema.extend({
  history: z.array(StructuredMemoryHistoryEntrySchema).default([]),
}).strict();

const StructuredMemoryEnvelopeV2Schema = StructuredMemoryCoreV2Schema.extend({
  history: z.array(StructuredMemoryHistoryEntrySchema).default([]),
}).strict();

// Agent-facing input for memory_upsert: no `version` (always written as
// the current schema version) and no `history` (server-managed).
export const StructuredMemoryInputSchema = z.object({
  ...sharedCoreFields,
  summary: z.string().trim().max(280).nullable().default(null),
  aliases: z.array(z.string().trim().min(1).max(48)).max(8).default([]),
  status: z.enum(MEMORY_STATUSES).default("active"),
}).strict();

export type StructuredMemoryInput = z.infer<typeof StructuredMemoryInputSchema>;
export type StructuredMemoryRecord = z.infer<typeof StructuredMemoryEnvelopeV2Schema>;
export type StructuredMemoryHistoryEntry = z.infer<typeof StructuredMemoryHistoryEntrySchema>;

function normalizeStructuredMemoryCandidate(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object") return candidate;
  const record = candidate as Record<string, unknown>;
  if ("current" in record && record.current && typeof record.current === "object") {
    const current = record.current as Record<string, unknown>;
    return { ...current, ...(record.history ? { history: record.history } : {}) };
  }
  return candidate;
}

// True when the raw stored value is a v1 envelope that parseStructuredMemory
// would upgrade. Used by the store layer to decide whether a read should
// write the upgraded record back (lazy migration, no batch job).
export function isLegacyStructuredMemoryRaw(raw: unknown): boolean {
  const normalized = normalizeStructuredMemoryCandidate(raw);
  return !!normalized && typeof normalized === "object" && (normalized as { version?: unknown }).version === 1;
}

export function parseStructuredMemory(value: unknown): StructuredMemoryRecord | null {
  const candidate = typeof value === "string" ? parseJson(value) : value;
  const normalized = normalizeStructuredMemoryCandidate(candidate);
  const v2 = StructuredMemoryEnvelopeV2Schema.safeParse(normalized);
  if (v2.success) return v2.data;
  const v1 = StructuredMemoryEnvelopeV1Schema.safeParse(normalized);
  if (!v1.success) return null;
  return { ...v1.data, version: CURRENT_STRUCTURED_MEMORY_VERSION, summary: null, aliases: [], status: "active" };
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
    [...record.tags, ...record.aliases].join(" "),
    record.summary ?? "",
    record.content,
  ].filter(Boolean).join(": ");
}

export function memoryRecallText(namespace: string, key: string, value: unknown): string | null {
  const record = parseStructuredMemory(value);
  if (!record) return stringifyMemoryValue(value);
  if (!isStructuredMemoryActive(record) || record.status === "archived") return null;
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
  if (!isStructuredMemoryActive(record) || record.status === "archived") return false;
  if (policy !== "important") return true;
  return record.confidence !== "inferred"
    && record.kind !== "contact"
    && record.kind !== "task";
}