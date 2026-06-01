// Row → JSON-response serializers shared between list (`route.ts`) and
// item (`[id]/route.ts`) handlers. Keeping these in one place stops the
// list and item shapes from drifting (they were copy-pasted before).

import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { getAgentTierProportions, parseDelegateTargets } from "@/lib/stores/agent-configs";
import type { BridgeRow } from "@/lib/stores/bridges";
import type { McpServerRow } from "@/lib/stores/mcp-servers";
import type { MessageRow } from "@/lib/stores/threads";
import type { MessageUsageRow } from "@/lib/stores/message-usage";
import { parseJsonSafe } from "@/lib/utils/json";

export function agentToResponse(a: AgentConfigRow) {
  return {
    id: a.id,
    name: a.name,
    icon: a.icon,
    identity: a.identity,
    instructions: a.instructions,
    tools: parseJsonSafe<string[]>(a.tools, []),
    model_config_name: a.model_config_name,
    is_default: !!a.is_default,
    history_limit: a.history_limit,
    history_window_hours: a.history_window_hours,
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
    created_at: r.created_at,
    updated_at: r.updated_at,
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
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    tool_events: parseToolEventsForResponse(m.tool_events),
    category: m.category ?? null,
    usage: messageUsageToResponse(usageById.get(m.msg_id)),
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
