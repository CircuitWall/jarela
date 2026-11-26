import { z } from "zod";

// Agent dreaming (ADR-0135): idle light compaction for every agent and weekly
// deep maintenance of the shared memory/knowledge stores by the default agent.
// Settings are installation-wide; per-agent opt-out lives in agent_dream_state.

const idleMinutes = z.number().int().min(15).max(1440);
const optionalTokenBudget = z.number().int().min(0).max(20_000_000);
const wallClockMs = z.number().int().min(10_000).max(3_600_000);

export const dreamingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Idle time before a light dream. Default 180 minutes (today's 3h hint). */
  light_idle_minutes: idleMinutes,
  /** Minimum foreground user turns after the current boundary. */
  light_min_user_turns: z.number().int().min(1).max(20),
  /** Executed light dreams per agent per local day, including skip no-ops. */
  light_max_per_day: z.number().int().min(1).max(48),
  /** Estimated-token ceiling per agent per local day. 0 = no token ceiling. */
  light_daily_token_budget: optionalTokenBudget,
  deep_enabled: z.boolean(),
  /** 0 = Sunday … 6 = Saturday, evaluated in the host's local time. */
  deep_weekday: z.number().int().min(0).max(6),
  deep_hour: z.number().int().min(0).max(23),
  /** Idle time since the newest foreground user turn before deep work. */
  deep_idle_minutes: idleMinutes,
  /** Total wall-clock ceiling for one deep dream. */
  deep_budget_ms: wallClockMs,
  /** Ceiling for the legacy-embedding rewrite phase. */
  deep_document_budget_ms: wallClockMs,
  /** Ceiling for the incremental reclaim phase. */
  deep_reclaim_budget_ms: wallClockMs,
  /** Estimated-token ceiling for deep model work. 0 = no ceiling. */
  deep_weekly_token_budget: optionalTokenBudget,
  /** Optional model config for deep model steps. NULL = default agent's model. */
  deep_model_config_name: z.string().trim().min(1).max(200).nullable(),
  /** Allow explicit model calls to merge near-duplicate facts. */
  deep_merge_enabled: z.boolean(),
  /** Maximum near-duplicate groups to ask the model about per deep dream. */
  deep_merge_max_groups: z.number().int().min(1).max(20),
  /** Allow the short, clearly labelled weekly consolidation note. */
  deep_review_enabled: z.boolean(),
});

export const dreamingSettingsPatchSchema = dreamingSettingsSchema.partial();

export const DREAMING_SETTINGS_DEFAULTS = {
  enabled: true,
  light_idle_minutes: 180,
  light_min_user_turns: 2,
  light_max_per_day: 6,
  light_daily_token_budget: 250_000,
  deep_enabled: true,
  deep_weekday: 0,
  deep_hour: 3,
  deep_idle_minutes: 15,
  deep_budget_ms: 600_000,
  deep_document_budget_ms: 180_000,
  deep_reclaim_budget_ms: 120_000,
  deep_weekly_token_budget: 500_000,
  deep_model_config_name: null,
  deep_merge_enabled: true,
  deep_merge_max_groups: 5,
  deep_review_enabled: true,
} as const satisfies DreamingSettings;

export const DREAM_KINDS = ["light", "deep"] as const;
export const dreamKindSchema = z.enum(DREAM_KINDS);
export type DreamKind = z.infer<typeof dreamKindSchema>;

export const DREAM_RUN_STATUSES = ["running", "completed", "partial", "failed", "skipped"] as const;
export const dreamRunStatusSchema = z.enum(DREAM_RUN_STATUSES);
export type DreamRunStatus = z.infer<typeof dreamRunStatusSchema>;

// Stable machine-readable reasons. The UI renders these; the journal records
// the reason for executed-but-skipped runs. Adding a reason is additive.
export const DREAM_SKIP_REASONS = [
  "disabled",
  "agent_disabled",
  "agent_not_found",
  "locked",
  "no_thread",
  "no_messages",
  "no_model",
  "active_run",
  "queued_turn",
  "compaction_in_flight",
  "dream_running",
  "not_idle",
  "too_few_turns",
  "summary_disabled",
  "already_dreamed",
  "daily_limit",
  "budget_exhausted",
  "retry_cooldown",
  "deep_not_due",
  "not_default_agent",
  "documents_busy",
] as const;
export const dreamSkipReasonSchema = z.enum(DREAM_SKIP_REASONS);
export type DreamSkipReason = z.infer<typeof dreamSkipReasonSchema>;

export const dreamReadinessSchema = z.object({
  eligible: z.boolean(),
  reason: dreamSkipReasonSchema.nullable(),
});
export type DreamReadiness = z.infer<typeof dreamReadinessSchema>;

export const dreamRunSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  kind: dreamKindSchema,
  status: dreamRunStatusSchema,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  estimated_input_tokens: z.number().int().nonnegative(),
  estimated_output_tokens: z.number().int().nonnegative(),
  stats: z.record(z.string(), z.unknown()).nullable(),
});
export type DreamRun = z.infer<typeof dreamRunSchema>;

export const dreamingAgentStatusSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  is_default: z.boolean(),
  enabled: z.boolean(),
  last_light_dream_at: z.string().nullable(),
  last_deep_dream_at: z.string().nullable(),
  last_light_boundary_seq: z.number().int().nullable(),
  last_error: z.string().nullable(),
  light: dreamReadinessSchema,
  deep: dreamReadinessSchema,
});
export type DreamingAgentStatus = z.infer<typeof dreamingAgentStatusSchema>;

export const dreamingRunningSchema = z.object({
  agent_id: z.string(),
  kind: dreamKindSchema,
  started_at: z.string(),
});
export type DreamingRunning = z.infer<typeof dreamingRunningSchema>;

export const dreamingOverviewSchema = z.object({
  settings: dreamingSettingsSchema,
  running: dreamingRunningSchema.nullable(),
  agents: z.array(dreamingAgentStatusSchema),
  runs: z.array(dreamRunSchema),
});
export type DreamingOverview = z.infer<typeof dreamingOverviewSchema>;

export const dreamingPatchSchema = z.object({
  settings: dreamingSettingsPatchSchema.optional(),
  agent: z.object({
    agent_id: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
  }).optional(),
}).refine((value) => value.settings !== undefined || value.agent !== undefined, {
  message: "settings or agent is required",
});
export type DreamingPatch = z.infer<typeof dreamingPatchSchema>;

export const dreamTriggerSchema = z.object({
  agent_id: z.string().trim().min(1).max(200),
  kind: dreamKindSchema,
  /** Bypass the idle threshold and weekly due time, never safety gates. */
  force: z.boolean().optional().default(false),
});
export type DreamTrigger = z.infer<typeof dreamTriggerSchema>;

export const dreamTriggerResponseSchema = z.object({
  accepted: z.literal(true),
  run: dreamRunSchema,
});
export type DreamTriggerResponse = z.infer<typeof dreamTriggerResponseSchema>;

export type DreamingSettings = z.infer<typeof dreamingSettingsSchema>;
export type DreamingSettingsPatch = z.infer<typeof dreamingSettingsPatchSchema>;
