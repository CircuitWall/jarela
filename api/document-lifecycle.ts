import { z } from "zod";

// Document-index lifecycle (ADR-0133): post-ingestion maintenance over the
// `documents` / `document_chunks` tables. Settings are install-wide; the
// inventory and maintenance status are read by the Documents panel and by
// the scheduler-driven sweep.

const retentionDays = z.number().int().min(0).max(3650);

export const documentIndexLifecycleSettingsSchema = z.object({
  /** Purge a disabled source's index after this many days. 0 = keep it. */
  purge_disabled_after_days: retentionDays,
});

export const documentIndexLifecyclePatchSchema = z.object({
  purge_disabled_after_days: retentionDays.optional(),
});

// Actions the browser may start. The scheduler-only `lifecycle` sweep is
// deliberately absent from this union: callers cannot request it directly.
export const documentIndexMaintenanceActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("purge_source"), source_id: z.string().min(1) }),
  z.object({ action: z.literal("purge_disabled") }),
  z.object({ action: z.literal("reclaim") }),
  z.object({ action: z.literal("vacuum"), confirm: z.literal(true) }),
]);

export const documentIndexAutoVacuumSchema = z.enum(["none", "full", "incremental"]);

export const documentIndexInventorySchema = z.object({
  document_count: z.number().int().nonnegative(),
  /** Sum of `documents.chunk_count`; never counts the chunk table itself. */
  chunk_count: z.number().int().nonnegative(),
  /** Logical database size (`page_count * page_size`). */
  size_bytes: z.number().int().nonnegative(),
  /** Pages currently on SQLite's freelist, reclaimable without compacting. */
  free_bytes: z.number().int().nonnegative(),
  auto_vacuum: documentIndexAutoVacuumSchema,
});

export const DOCUMENT_INDEX_MAINTENANCE_ACTION_NAMES = [
  "purge_source",
  "purge_disabled",
  "reclaim",
  "vacuum",
  "lifecycle",
] as const;

export const documentIndexMaintenanceStatusSchema = z.object({
  running: z.boolean(),
  action: z.enum(DOCUMENT_INDEX_MAINTENANCE_ACTION_NAMES).nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  /** Human-readable outcome of the last completed action. */
  summary: z.string().nullable(),
  error: z.string().nullable(),
});

export const documentIndexLifecycleResponseSchema = z.object({
  settings: documentIndexLifecycleSettingsSchema,
  inventory: documentIndexInventorySchema,
  status: documentIndexMaintenanceStatusSchema,
});

export const documentIndexMaintenanceAcceptedSchema = z.object({
  accepted: z.boolean(),
  status: documentIndexMaintenanceStatusSchema,
});

export type DocumentIndexLifecycleSettings = z.infer<typeof documentIndexLifecycleSettingsSchema>;
export type DocumentIndexLifecyclePatch = z.infer<typeof documentIndexLifecyclePatchSchema>;
export type DocumentIndexMaintenanceAction = z.infer<typeof documentIndexMaintenanceActionSchema>;
export type DocumentIndexMaintenanceActionName = typeof DOCUMENT_INDEX_MAINTENANCE_ACTION_NAMES[number];
export type DocumentIndexAutoVacuum = z.infer<typeof documentIndexAutoVacuumSchema>;
export type DocumentIndexInventory = z.infer<typeof documentIndexInventorySchema>;
export type DocumentIndexMaintenanceStatus = z.infer<typeof documentIndexMaintenanceStatusSchema>;
export type DocumentIndexLifecycleResponse = z.infer<typeof documentIndexLifecycleResponseSchema>;
export type DocumentIndexMaintenanceAccepted = z.infer<typeof documentIndexMaintenanceAcceptedSchema>;
