// ADR-0041. Immutable per-assistant-turn snapshot of LLM usage.
//
// Written once when an assistant turn is persisted (see
// `persistAssistantMessage` in lib/agents/run-thread.ts). Never updated.
// The dashboard reads this table in preference to recomputing tokens /
// cost from `messages.content` + current agent_configs joins.

import { getDb } from "@/lib/db";

export interface MessageUsageInput {
  message_id: string;
  thread_id: string;
  agent_id: string;
  agent_name: string;
  provider: string;
  model_id: string;
  model_config_name: string | null;
  input_tokens: number;
  output_tokens: number;
  input_rate_usd_per_mtok: number | null;
  output_rate_usd_per_mtok: number | null;
  cost_usd: number;
  // Per-tier input-token breakdown captured from the history-window
  // assembly. NULL/undefined when unknown (very old assistant turns
  // persisted before the breakdown was wired up, or non-LLM persists).
  tier_usage?: TierUsage | null;
}

export interface TierUsage {
  hot_tokens: number;
  warm_tokens: number;
  facts_tokens: number;
  overhead_tokens: number;
  hot_budget_tokens: number;
  warm_budget_tokens: number;
  facts_budget_tokens: number;
  context_window_tokens: number;
}

export interface MessageUsageRow extends Omit<MessageUsageInput, "tier_usage"> {
  created_at: string;
  hot_tokens: number | null;
  warm_tokens: number | null;
  facts_tokens: number | null;
  overhead_tokens: number | null;
  hot_budget_tokens: number | null;
  warm_budget_tokens: number | null;
  facts_budget_tokens: number | null;
  context_window_tokens: number | null;
}

export function recordMessageUsage(input: MessageUsageInput): void {
  const db = getDb();
  const t = input.tier_usage ?? null;
  db.prepare(
    `INSERT OR IGNORE INTO message_usage (
       message_id, thread_id, agent_id, agent_name, provider, model_id,
       model_config_name, input_tokens, output_tokens,
       input_rate_usd_per_mtok, output_rate_usd_per_mtok, cost_usd, created_at,
       hot_tokens, warm_tokens, facts_tokens, overhead_tokens,
       hot_budget_tokens, warm_budget_tokens, facts_budget_tokens, context_window_tokens
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.message_id,
    input.thread_id,
    input.agent_id,
    input.agent_name,
    input.provider,
    input.model_id,
    input.model_config_name,
    input.input_tokens,
    input.output_tokens,
    input.input_rate_usd_per_mtok,
    input.output_rate_usd_per_mtok,
    input.cost_usd,
    new Date().toISOString(),
    t?.hot_tokens ?? null,
    t?.warm_tokens ?? null,
    t?.facts_tokens ?? null,
    t?.overhead_tokens ?? null,
    t?.hot_budget_tokens ?? null,
    t?.warm_budget_tokens ?? null,
    t?.facts_budget_tokens ?? null,
    t?.context_window_tokens ?? null,
  );
}

export function getMessageUsage(messageId: string): MessageUsageRow | null {
  return (getDb()
    .prepare("SELECT * FROM message_usage WHERE message_id=?")
    .get(messageId) as MessageUsageRow | undefined) ?? null;
}

/**
 * Batch lookup keyed by message_id. Returns a Map missing any ids that
 * have no usage row (user turns, legacy rows). Used by the threads GET
 * route to attach per-turn token counts to a page of messages without
 * issuing one SELECT per row.
 */
export function getMessageUsageByIds(messageIds: readonly string[]): Map<string, MessageUsageRow> {
  const out = new Map<string, MessageUsageRow>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM message_usage WHERE message_id IN (${placeholders})`)
    .all(...messageIds) as unknown as MessageUsageRow[];
  for (const row of rows) out.set(row.message_id, row);
  return out;
}

export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputRatePerMTok: number | null | undefined,
  outputRatePerMTok: number | null | undefined,
): number {
  const inCost = inputRatePerMTok && inputTokens > 0
    ? (inputTokens / 1_000_000) * inputRatePerMTok
    : 0;
  const outCost = outputRatePerMTok && outputTokens > 0
    ? (outputTokens / 1_000_000) * outputRatePerMTok
    : 0;
  return inCost + outCost;
}
