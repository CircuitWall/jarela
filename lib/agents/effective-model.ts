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
  const defaultModel = models.find((m) => m.is_default) ?? models[0] ?? null;
  if (!agent?.model_config_name) return defaultModel;
  return models.find((m) => m.name === agent.model_config_name) ?? defaultModel;
}

export type AgentModelStatus =
  | { state: "ok"; model: ModelConfig }
  // Agent has no explicit model AND no workspace default is set. Any run
  // will throw `no_model` at the LLM layer — for unattended runs
  // (scheduled tasks, watchers) this fails without the operator watching.
  | { state: "no-model" }
  // Agent row itself wasn't found (e.g. deleted between fetches). Anything
  // pointing at this agent will fail at the trigger handler.
  | { state: "no-agent" };

/**
 * Diagnose whether an agent has a runnable model RIGHT NOW. Used by the
 * Scheduled Tasks and Watchers panels to surface model-availability issues
 * before an unattended run silently no-ops with `no_model`.
 */
export function agentModelStatus(
  agent: Pick<AgentConfig, "model_config_name"> | null | undefined,
  models: readonly ModelConfig[],
): AgentModelStatus {
  if (!agent) return { state: "no-agent" };
  const effectiveModel = resolveAgentModel(agent, models);
  if (effectiveModel) return { state: "ok", model: effectiveModel };
  return { state: "no-model" };
}
