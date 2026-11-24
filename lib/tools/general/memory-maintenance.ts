import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  applyMemoryMaintenance,
  auditMemory,
  MEMORY_APPLY_MAX_OPERATIONS,
  MEMORY_AUDIT_FINDINGS,
  MEMORY_BULK_LIMIT_MAX,
} from "@/lib/memory/maintenance";
import { MEMORY_FACTS_NAMESPACE, MEMORY_KEY_RULE } from "@/lib/memory/contract";
import { StructuredMemoryInputSchema } from "@/lib/memory/record";
import { registerLangChainPackage } from "../packages/langchain-package";

const fingerprint = z.string().regex(/^[a-f0-9]{32}$/)
  .describe("Fingerprint from memory_audit for the exact revision you reviewed.");

const auditSchema = z.object({
  now: z.string().datetime().optional()
    .describe("Explicit UTC time for expiry comparisons. Defaults to the current time."),
  namespace: z.string().trim().min(1).max(120).optional()
    .describe("Restrict the audit to one maintainable namespace, typically 'facts'."),
  findings: z.array(z.enum(MEMORY_AUDIT_FINDINGS)).min(1).max(6).optional()
    .describe(`Limit grouped detail to these findings. Counts still cover all findings. Omit for ${MEMORY_AUDIT_FINDINGS.join(", ")}.`),
  near_duplicate_similarity: z.number().min(0.5).max(1).optional()
    .describe("Token-overlap threshold for near-duplicate candidates (default 0.8). Matching text never proves equivalence."),
  max_groups: z.number().int().min(1).max(100).optional()
    .describe("Groups returned on this page (default 20). Follow next_cursor for more."),
  cursor: z.string().max(32).optional()
    .describe("next_cursor from the previous page with the same parameters."),
  batch_size: z.number().int().min(50).max(2000).optional()
    .describe("Rows read per keyset batch while scanning (default 500). Bounds one batch, not the store."),
});

const operationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("archive"),
    namespace: z.string().trim().min(1).max(120),
    key: z.string().trim().min(1).max(200),
    expected_fingerprint: fingerprint,
  }).describe("Soft-retire one structured record. The stored value and its revision history are kept."),
  z.strictObject({
    action: z.literal("delete"),
    namespace: z.string().trim().min(1).max(120),
    key: z.string().trim().min(1).max(200),
    expected_fingerprint: fingerprint,
  }).describe("Permanently remove one record. Prefer archive unless the user asked for deletion."),
  z.strictObject({
    action: z.literal("upsert"),
    namespace: z.string().trim().min(1).max(120),
    key: z.string().trim().min(1).max(200),
    expected_fingerprint: fingerprint.nullable()
      .describe("Fingerprint of the record being replaced, or null to create a new key."),
    record: StructuredMemoryInputSchema,
  }).describe("Write consolidated or restructured content. Converts an unstructured legacy value in place and keeps its key."),
  z.strictObject({
    action: z.literal("archive_expired"),
    limit: z.number().int().min(1).max(MEMORY_BULK_LIMIT_MAX).optional(),
  }).describe("Code-selected bulk action: archive active records whose expiry is at or before now."),
  z.strictObject({
    action: z.literal("archive_duplicates"),
    limit: z.number().int().min(1).max(MEMORY_BULK_LIMIT_MAX).optional(),
  }).describe("Code-selected bulk action: archive exact duplicates, keeping the strongest-provenance survivor."),
]);

const applySchema = z.object({
  now: z.string().datetime().optional()
    .describe("Explicit UTC time for archive_expired. Defaults to the current time."),
  dry_run: z.boolean().default(true)
    .describe("Default true. Validates every operation and reports the plan without writing. Set false only after the user approves the exact plan."),
  allow_non_facts_namespaces: z.boolean().default(false)
    .describe("Writes and bulk scans stay inside the canonical 'facts' namespace unless this is true. Set it only when the user explicitly asked to clean or restructure a specific legacy namespace they named."),
  operations: z.array(operationSchema).min(1).max(MEMORY_APPLY_MAX_OPERATIONS),
});

function respond(work: () => unknown): string {
  try {
    return JSON.stringify(work());
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Memory maintenance failed" });
  }
}

export const memoryAuditTool = tool(
  async (input) => respond(() => auditMemory({
    now: input.now ?? new Date().toISOString(),
    namespace: input.namespace,
    findings: input.findings,
    nearDuplicateSimilarity: input.near_duplicate_similarity,
    maxGroups: input.max_groups,
    cursor: input.cursor,
    batchSize: input.batch_size,
  })),
  {
    name: "memory_audit",
    description:
      "Read-only, code-backed audit of saved memory, in ordered batches, so it works the same at any store size. "
      + "Reports active and archived counts, per-namespace totals and paged candidate groups for: expired records, exact duplicates, near-duplicate candidates, "
      + "legacy unstructured values, records that look structured but fail validation, and records without an embedding. "
      + "Results are a bounded page: follow next_cursor until it is null to cover every group, and never assume the first page is the whole store. "
      + "Excluded namespaces (secrets, app and Security settings, app lifecycle state, compacted session recaps, advertisements, chat archive) are counted but never read. "
      + `Every record carries a fingerprint pinning the revision you reviewed; memory_apply_maintenance rejects anything that changed since. `
      + "Matching text is a candidate signal only — read full records with memory_read before deciding that two differently worded records are equivalent. "
      + "Use this instead of memory_list for cleanup: memory_list returns rows, not findings, and degrades with store size.",
    schema: auditSchema,
  },
);

export const memoryApplyMaintenanceTool = tool(
  async (input) => respond(() => applyMemoryMaintenance({
    now: input.now ?? new Date().toISOString(),
    dryRun: input.dry_run,
    allowNonFactsNamespaces: input.allow_non_facts_namespaces,
    operations: input.operations,
  })),
  {
    name: "memory_apply_maintenance",
    description:
      "Apply an approved memory maintenance plan in one transaction. dry_run defaults to true, so the first call previews effects without writing; "
      + "set dry_run=false only after the user has seen and approved that exact plan. "
      + "Supports per-record archive (soft retire, history kept), delete (permanent), and upsert of consolidated or restructured content. "
      + `upsert converts a legacy unstructured value in place under the same key; for '${MEMORY_FACTS_NAMESPACE}' keys use ${MEMORY_KEY_RULE}. `
      + "Every per-record operation must carry the fingerprint from memory_audit: a record that changed since the audit returns status 'stale' and is not written. "
      + "archive_expired and archive_duplicates apply fully specified rules in code, up to the limit, and report matched, affected and stale counts — use them instead of enumerating hundreds of records yourself. "
      + "Writes and bulk scans stay in 'facts' unless allow_non_facts_namespaces is set for a legacy namespace the user named explicitly. "
      + `Bounded to ${MEMORY_APPLY_MAX_OPERATIONS} operations per call; batch large plans. Never writes excluded namespaces or Security settings.`,
    schema: applySchema,
  },
);

registerLangChainPackage({
  category: "Memory",
  tools: {
    read: [memoryAuditTool],
    write: [memoryApplyMaintenanceTool],
  },
});
