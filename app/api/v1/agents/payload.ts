import type { MbtiType } from "@/lib/agents/adaptive-persona-presets";
import type { AgentConfigRow, UpsertAgentInput } from "@/lib/stores/agent-configs";
import type { AgentConfigIn } from "@/api/types";
import { parseJsonSafe } from "@/lib/utils/json";

export type AgentCreateBody = AgentConfigIn;
export type AgentUpdateBody = Partial<AgentConfigIn>;

export function toCreateAgentInput(id: string, body: AgentCreateBody): UpsertAgentInput {
  return {
    id,
    name: body.name.trim(),
    icon: body.icon ?? null,
    identity: body.identity ?? "",
    instructions: body.instructions ?? "",
    tools: body.tools ?? [],
    model_config_name: body.model_config_name ?? null,
    is_default: body.is_default,
    history_limit: body.history_limit,
    history_window_hours: body.history_window_hours,
    never_reply: body.never_reply,
    adaptive_persona_enabled: body.adaptive_persona_enabled,
    adaptive_persona_strength: body.adaptive_persona_strength,
    adaptive_empathy: body.adaptive_empathy,
    adaptive_expressiveness: body.adaptive_expressiveness,
    adaptive_verbosity: body.adaptive_verbosity,
    adaptive_mbti: body.adaptive_mbti as MbtiType | undefined,
    voice_enabled: body.voice_enabled,
    voice_model: body.voice_model,
    voice_name: body.voice_name,
    voice_stt_model: body.voice_stt_model,
    voice_auto_speak: body.voice_auto_speak,
    harness_id: body.harness_id,
  };
}

export function toUpdateAgentInput(
  id: string,
  body: AgentUpdateBody,
  existing: AgentConfigRow,
): UpsertAgentInput {
  return {
    id,
    name: body.name?.trim() ?? existing.name,
    icon: "icon" in body ? (body.icon ?? null) : existing.icon,
    identity: body.identity ?? existing.identity,
    instructions: body.instructions ?? existing.instructions,
    tools: body.tools ?? parseJsonSafe<string[]>(existing.tools, []),
    model_config_name: "model_config_name" in body ? (body.model_config_name ?? null) : existing.model_config_name,
    is_default: body.is_default,
    history_limit: body.history_limit,
    history_window_hours: body.history_window_hours,
    never_reply: body.never_reply,
    adaptive_persona_enabled: body.adaptive_persona_enabled,
    adaptive_persona_strength: body.adaptive_persona_strength,
    adaptive_empathy: body.adaptive_empathy,
    adaptive_expressiveness: body.adaptive_expressiveness,
    adaptive_verbosity: body.adaptive_verbosity,
    adaptive_mbti: body.adaptive_mbti as MbtiType | undefined,
    voice_enabled: body.voice_enabled,
    voice_model: body.voice_model,
    voice_name: body.voice_name,
    voice_stt_model: body.voice_stt_model,
    voice_auto_speak: body.voice_auto_speak,
    harness_id: "harness_id" in body ? body.harness_id : undefined,
  };
}
