"use client";

import { useRef, useState } from "react";
import type { AgentConfig, AgentConfigIn, ModelConfig } from "@/api/types";
import { api } from "@/api/client";
import { useListState } from "@/hooks/useListState";
import { Select } from "@/components/ui/Select";
import { isModelEnabled } from "@/lib/agents/effective-model";
import { pushErrorToast } from "@/lib/ui/error-report";
import { errorMessage } from "@/lib/utils/error";

export type AgentCardSettings = Pick<AgentConfig, "id" | "model_config_name" | "usage_strategy" | "voice_enabled">;
export type UpdateCardAgent = (id: string, data: Partial<AgentConfigIn>) => Promise<AgentConfig>;
type SettingsPatch = Pick<AgentConfigIn, "model_config_name" | "usage_strategy" | "voice_enabled">;

const STRATEGIES = [
  { value: "cost_saving", label: "Economical" },
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "high_reasoning", label: "High reasoning" },
] as const;

export function AgentCardControls({ agent, isFullMode, onUpdate }: {
  agent: AgentCardSettings;
  isFullMode: boolean;
  onUpdate: UpdateCardAgent;
}) {
  const { items: models, loading, error: modelsError, refresh } = useListState<ModelConfig>({
    loader: () => api.models.list(),
    eventName: "jarela:models-changed",
    initialLoading: true,
  });
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<SettingsPatch | null>(null);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const displayedAgent = { ...agent, ...pending };
  const selectedModel = models.find((model) => model.name === displayedAgent.model_config_name);
  const unavailableOverride = !!displayedAgent.model_config_name && (!selectedModel || !isModelEnabled(selectedModel));
  const enabledModels = models.filter(isModelEnabled);

  async function save(patch: SettingsPatch) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setPending(patch);
    setError(null);
    setSaved(false);
    try {
      await onUpdate(agent.id, patch);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
      pushErrorToast({
        title: "Could not update agent settings",
        error: cause,
        context: { panel: "agent-card", action: "agent.update", agent_id: agent.id },
      });
    } finally {
      savingRef.current = false;
      setPending(null);
      setSaving(false);
    }
  }

  return (
    <fieldset aria-label="Quick agent settings" disabled={saving} className="min-w-0 space-y-3 border-t border-border/60 pt-3">
      <label className="block space-y-1 text-xs text-fg-muted">
        <span>Model</span>
        <Select
          size="sm"
          className="min-h-11 min-w-0"
          value={displayedAgent.model_config_name ?? ""}
          disabled={loading || !!modelsError}
          onChange={(event) => void save({ model_config_name: event.target.value || null })}
        >
          <option value="">Automatic routing</option>
          {unavailableOverride && (
            <option value={displayedAgent.model_config_name ?? ""} disabled>{displayedAgent.model_config_name} ({selectedModel ? "disabled" : "unavailable"})</option>
          )}
          {enabledModels.map((model) => (
            <option key={model.name} value={model.name}>{model.name} - {model.provider} / {model.model_id}</option>
          ))}
        </Select>
      </label>
      {loading ? <p role="status" className="text-[11px] text-fg-faint">Loading models...</p> : modelsError ? (
        <div className="space-y-1 text-xs text-fg-muted">
          <p role="alert">Could not load models: {modelsError}</p>
          <button type="button" onClick={() => void refresh()} className="control-tap min-h-11 underline">Retry loading models</button>
        </div>
      ) : (
        <>
          {unavailableOverride && <p className="text-[11px] text-amber-700 dark:text-amber-300">The saved model override is unavailable. Automatic routing is used until it is available again.</p>}
          {enabledModels.length === 0 && <p className="text-[11px] text-amber-700 dark:text-amber-300">No enabled models. Configure one in Settings before chatting.</p>}
        </>
      )}
      {isFullMode && (
        <label className="block space-y-1 text-xs text-fg-muted">
          <span>Usage strategy</span>
          <Select
            size="sm"
            className="min-h-11 min-w-0"
            value={displayedAgent.usage_strategy ?? ""}
            onChange={(event) => {
              const strategy = STRATEGIES.find((item) => item.value === event.target.value);
              void save({ usage_strategy: strategy?.value ?? null });
            }}
          >
            <option value="">Inherit global strategy</option>
            {STRATEGIES.map((strategy) => <option key={strategy.value} value={strategy.value}>{strategy.label}</option>)}
          </Select>
        </label>
      )}
      <label className="control-tap flex min-h-11 cursor-pointer items-center gap-2 text-xs text-fg-muted">
        <input type="checkbox" className="rounded border-border" checked={displayedAgent.voice_enabled} onChange={(event) => void save({ voice_enabled: event.target.checked })} />
        Enable voice
      </label>
      <p className="text-[11px] leading-relaxed text-fg-faint">Voice requires a configured Google AI integration for Gemini speech services.</p>
      <p className="text-[11px] leading-relaxed text-fg-faint">Saves for this agent across conversations. Model and strategy changes apply to new runs; they do not restart a running reply.</p>
      {saving && <p role="status" className="text-xs text-fg-muted">Saving agent settings...</p>}
      {error && <p role="alert" className="break-words text-xs text-fg-muted">Could not save settings: {error}</p>}
      {!saving && saved && <p role="status" className="text-xs text-fg-muted">Agent settings saved.</p>}
    </fieldset>
  );
}
