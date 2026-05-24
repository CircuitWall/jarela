import type { AgentConfig, ModelConfig } from "@/api/types";

/**
 * Resolve which `ModelConfig` will actually be used for an agent at runtime.
 *
 * Mirrors what `lib/agents/llm.ts` does server-side: when an agent has
 * `model_config_name` set, that wins; otherwise the workspace-wide default
 * model is used. Both client (BridgeEditor, AgentEditor capability hints)
 * and server need the same logic — this is the single source of truth.
 *
 * Returns `null` only when neither the requested config nor the default
 * exists in the provided list (typically: no models configured yet).
 */
export function resolveAgentModel(
  agent: Pick<AgentConfig, "model_config_name"> | null | undefined,
  models: readonly ModelConfig[],
): ModelConfig | null {
  const defaultModel = models.find((m) => m.is_default) ?? null;
  if (!agent?.model_config_name) return defaultModel;
  return models.find((m) => m.name === agent.model_config_name) ?? defaultModel;
}
