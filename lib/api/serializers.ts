// Row → JSON-response serializers shared between list (`route.ts`) and
// item (`[id]/route.ts`) handlers. Keeping these in one place stops the
// list and item shapes from drifting (they were copy-pasted before).

import { DEFAULT_HOT_TURN_LIMIT } from "@/api/types";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { getAgentTierProportions, getAgentToolCredentials, parseCitationStrictness, parseDelegateTargets } from "@/lib/stores/agent-configs";
import type { BridgeRow, BridgeRouteRow } from "@/lib/stores/bridges";
import type { SkillRepoRow } from "@/lib/stores/skill-repos";
import type { McpServerRow } from "@/lib/stores/mcp-servers";
import type { MessageRow } from "@/lib/stores/threads";
import type { MessageUsageRow } from "@/lib/stores/message-usage";
import { parseJsonSafe } from "@/lib/utils/json";
import type { PendingActionRow } from "@/lib/stores/pending-actions";
import type { DocumentSourceRow, DocumentSourceStats } from "@/lib/stores/document-sources";

export function documentSourceToResponse(row: DocumentSourceRow, stats: DocumentSourceStats) {
  const config: unknown = row.config ? JSON.parse(row.config) : null;
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled === 1,
    last_scan_at: row.last_scan_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kind: row.kind,
    config,
    stats,
  };
}

export function pendingActionToResponse(row: PendingActionRow) {
  return {
    ...row,
    payload: JSON.parse(row.payload),
    result: row.result ? parseJsonSafe<unknown>(row.result, row.result) : null,
  };
}

export function agentToResponse(a: AgentConfigRow) {
  return {
    id: a.id,
    usage_profile: a.usage_profile ?? "custom",
    name: a.name,
    icon: a.icon,
    identity: a.identity,
    instructions: a.instructions,
    tools: parseJsonSafe<string[]>(a.tools, []),
    model_config_name: a.model_config_name,
    is_default: !!a.is_default,
    history_limit: a.history_limit,
    history_window_hours: a.history_window_hours,
    hot_turn_limit: a.hot_turn_limit ?? DEFAULT_HOT_TURN_LIMIT,
    warm_summary_limit: a.warm_summary_limit,
    never_reply: !!a.never_reply,
    adaptive_persona_enabled: !!a.adaptive_persona_enabled,
    adaptive_persona_strength: a.adaptive_persona_strength,
    adaptive_empathy: a.adaptive_empathy,
    adaptive_expressiveness: a.adaptive_expressiveness,
    adaptive_verbosity: a.adaptive_verbosity,
    adaptive_mbti: a.adaptive_mbti,
    voice_enabled: !!a.voice_enabled,
    voice_model: a.voice_model,
    voice_name: a.voice_name,
    voice_stt_model: a.voice_stt_model,
    voice_auto_speak: !!a.voice_auto_speak,
    harness_id: a.harness_id,
    delegate_targets: parseDelegateTargets(a.delegate_targets),
    context_tier_proportions: getAgentTierProportions(a),
    anti_hallucination_mode: (a.anti_hallucination_mode === "off" || a.anti_hallucination_mode === "regex" || a.anti_hallucination_mode === "model")
      ? a.anti_hallucination_mode
      : null,
    anti_hallucination_model_config: a.anti_hallucination_model_config,
    citation_strictness: parseCitationStrictness(a.citation_strictness) ?? "off",
    tool_credentials: getAgentToolCredentials(a),
    router_policy: (a.router_policy === "cheap" || a.router_policy === "fast" || a.router_policy === "balanced" || a.router_policy === "quality")
      ? a.router_policy
      : null,
    router_enabled: a.router_enabled === 1 ? true : a.router_enabled === 0 ? false : null,
    usage_strategy: (a.usage_strategy === "cost_saving" || a.usage_strategy === "balanced" || a.usage_strategy === "high_reasoning")
      ? a.usage_strategy
      : null,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function bridgeToResponse(r: BridgeRow) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    status: r.status,
    last_error: r.last_error,
    paired_id: r.paired_id,
    enabled: r.enabled === 1,
    event_subscriptions: {
      group_profile_updates: r.forward_group_profile_updates === 1,
      group_participants_updates: r.forward_group_participants_updates === 1,
    },
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function bridgeRouteToResponse(r: BridgeRouteRow) {
  return {
    id: r.id,
    bridge_id: r.bridge_id,
    remote_jid: r.remote_jid,
    agent_id: r.agent_id,
    label: r.label,
    silent_mode: r.silent_mode === 1,
    respond_to: r.respond_to,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function skillRepoToResponse(row: SkillRepoRow) {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    writable: row.writable === 1,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mcpServerToResponse(r: McpServerRow) {
  return {
    name: r.name,
    transport: r.transport,
    spec: parseJsonSafe<unknown>(r.spec, null),
    enabled: r.enabled === 1,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Shape a `message_usage` row into the over-the-wire `usage` object the
 * chat panel's `ContextUsageBar` consumes. Returns `null` for messages
 * that have no snapshot (user turns and legacy assistant rows recorded
 * before the per-turn snapshot landed in ADR-0041).
 *
 * Anthropic prompt-cache tokens (PR #181 + the cache-fidelity follow-up)
 * are surfaced as additive fields so future UI work can render a
 * "served from cache" badge without another wire change. Both are
 * `null` for rows that predate cache plumbing or for providers that
 * don't expose a cache breakdown.
 */
export function messageUsageToResponse(u: MessageUsageRow | undefined | null) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    hot_tokens: u.hot_tokens,
    warm_tokens: u.warm_tokens,
    facts_tokens: u.facts_tokens,
    overhead_tokens: u.overhead_tokens,
    hot_budget_tokens: u.hot_budget_tokens,
    warm_budget_tokens: u.warm_budget_tokens,
    facts_budget_tokens: u.facts_budget_tokens,
    context_window_tokens: u.context_window_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    thinking_tokens: u.thinking_tokens ?? null,
    cost_usd: u.cost_usd ?? null,
  };
}

/**
 * Shape one message row into its over-the-wire form, attaching its
 * per-turn `usage` snapshot when one exists. Pure data-shaping helper
 * extracted from the threads GET route so the wire contract has unit
 * coverage.
 */
export function messageToResponse(
  m: MessageRow,
  usageById: ReadonlyMap<string, MessageUsageRow>,
) {
  return {
    id: m.msg_id,
    seq: m.seq,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    transcript_status: m.transcript_status,
    status_reason: m.status_reason,
    tool_events: parseToolEventsForResponse(m.tool_events),
    category: m.category ?? null,
    usage: messageUsageToResponse(usageById.get(m.msg_id)),
    metadata: parseMessageMetadataForResponse(m.metadata),
  };
}

/** Tolerant `tool_events` JSON parser shared with the route. Bad JSON
 *  and non-array payloads collapse to `undefined` so the wire shape
 *  always matches the typed client expectation. */
export function parseToolEventsForResponse(raw: string | null | undefined): unknown[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Tolerant `metadata` JSON parser. Returns `null` for missing/blank/
 *  malformed/non-object payloads so the wire shape stays a plain object
 *  or null — readers can rely on `metadata?.citations?...` chaining. */
export function parseMessageMetadataForResponse(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the bar's 100% baseline. Per-row `context_window_tokens`
 * (snapshotted at run time) wins so the bar matches the cap the agent
 * actually applied; legacy rows fall back to the model-config value;
 * unconfigured agents fall back to the default. Centralised so the
 * route and the UI share the same precedence rule.
 */
export function resolveContextWindowTokens(
  modelConfiguredTokens: number | null | undefined,
  defaultTokens: number,
): number {
  if (typeof modelConfiguredTokens === "number" && modelConfiguredTokens > 0) {
    return modelConfiguredTokens;
  }
  return defaultTokens;
}
