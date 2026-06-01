// Row → JSON-response serializers shared between list (`route.ts`) and
// item (`[id]/route.ts`) handlers. Keeping these in one place stops the
// list and item shapes from drifting (they were copy-pasted before).

import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { getAgentTierProportions, parseDelegateTargets } from "@/lib/stores/agent-configs";
import type { BridgeRow } from "@/lib/stores/bridges";
import type { McpServerRow } from "@/lib/stores/mcp-servers";
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
