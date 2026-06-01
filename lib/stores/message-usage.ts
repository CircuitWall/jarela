// ADR-0038. Immutable per-assistant-turn snapshot of LLM usage.
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
}

export interface MessageUsageRow extends MessageUsageInput {
  created_at: string;
}

export function recordMessageUsage(input: MessageUsageInput): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO message_usage (
       message_id, thread_id, agent_id, agent_name, provider, model_id,
       model_config_name, input_tokens, output_tokens,
       input_rate_usd_per_mtok, output_rate_usd_per_mtok, cost_usd, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
  );
}

export function getMessageUsage(messageId: string): MessageUsageRow | null {
  return (getDb()
    .prepare("SELECT * FROM message_usage WHERE message_id=?")
    .get(messageId) as MessageUsageRow | undefined) ?? null;
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
