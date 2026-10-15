import type { IntegrationStatus, ModelConfig } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";
import { HarnessField } from "./HarnessField";
import { AntiHallucinationFields, CitationStrictnessField } from "./HallucinationFields";
import { TierOverrideField } from "./TierOverrideField";
import { AdaptivePersonaFields } from "./AdaptivePersonaFields";
import { VoiceFields } from "./VoiceFields";
import { ToolCredentialsSection } from "./ToolCredentialsSection";
import { Select } from "@/components/ui/Select";
import { modelSupportsImages } from "@/lib/providers/capabilities";
import { isModelEnabled } from "@/lib/agents/effective-model";
import { SelectedModelDescription } from "./ModelSection";

interface Props {
  form: AgentEditorForm;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
  isFullMode: boolean;
  onClose: (after?: () => void) => void;
}

const Divider = () => <hr className="border-border/60 my-2" />;

export function AdvancedSection({ form, models, integrations, isFullMode, onClose }: Props) {
  const selectedModel = models.find((m) => m.name === form.modelConfigName);
  return (
    <Section title="Advanced settings" defaultCollapsed={true}>
      <div className="space-y-2">
        <p className="text-[11px] text-fg-subtle leading-snug">
          Optional override: force this agent onto one specific model instead of using the automatic router.
        </p>
        <Select value={form.modelConfigName} onChange={(e) => form.setModelConfigName(e.target.value)}>
          <option value="">Automatic routing (recommended)</option>
          {models.filter((m) => isModelEnabled(m) || m.name === form.modelConfigName).map((m) => {
            const vision = modelSupportsImages(m.provider, m.model_id);
            return (
              <option key={m.name} value={m.name}>
                {vision ? "📷 " : ""}{m.name} · {m.provider} / {m.model_id}{isModelEnabled(m) ? "" : " (disabled)"}
              </option>
            );
          })}
        </Select>
        {selectedModel && !isModelEnabled(selectedModel) && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            This model is disabled, so the agent uses automatic routing until it is enabled again.
          </p>
        )}
        {selectedModel && <SelectedModelDescription model={selectedModel} prefix="Forced" />}
      </div>
      <Divider />
      <div className="space-y-2">
        <p className="text-[11px] text-fg-subtle leading-snug font-medium">Usage strategy</p>
        <Select
          value={form.usageStrategy}
          onChange={(e) => form.setUsageStrategy(e.target.value as typeof form.usageStrategy)}
        >
          <option value="">Inherit global strategy</option>
          <option value="cost_saving">Economical</option>
          <option value="fast">Fast</option>
          <option value="balanced">Balanced</option>
          <option value="high_reasoning">High reasoning</option>
        </Select>
        <p className="text-[10px] text-fg-faint leading-snug">
          The strategy sets model selection, token/context budgets, thinking, retries, and recall behavior. High reasoning automatically recalls saved facts and prior chats; other strategies rely on explicit searches.
        </p>
      </div>
      <Divider />
      <TierOverrideField form={form} selectedModel={selectedModel} />
      <Divider />
      <div className="space-y-2">
        <p className="text-[11px] text-fg-subtle leading-snug font-medium">Conversation history</p>
        <div className="grid grid-cols-2 gap-2">
          <HistoryNumberField
            id="hot-turn-limit"
            label="Full-text turns"
            description="Recent turns sent as-is. 0 = token budget only."
            value={form.hotTurnLimit}
            onChange={form.setHotTurnLimit}
          />
          <HistoryNumberField
            id="warm-summary-limit"
            label="Prior-topic messages"
            description="Recent earlier messages summarized. 0 = off."
            value={form.warmSummaryLimit}
            onChange={form.setWarmSummaryLimit}
          />
        </div>
        <p className="text-[10px] text-fg-faint leading-snug">
          Compaction starts near the full-text token budget and preserves topic boundaries. Older chats can surface through memory recall when enabled.
        </p>
      </div>
      <details className="space-y-2">
        <summary className="cursor-pointer text-[10px] text-fg-faint">Source limits</summary>
        <div className="grid grid-cols-2 gap-2">
          <HistoryNumberField
            id="history-limit"
            label="Message limit"
            description="Maximum source messages. 0 = unlimited."
            value={form.historyLimit}
            onChange={form.setHistoryLimit}
          />
          <HistoryNumberField
            id="history-window-hours"
            label="History age (hours)"
            description="Ignore older source messages. 0 = no age limit."
            value={form.historyWindowHours}
            onChange={form.setHistoryWindowHours}
          />
        </div>
      </details>
      <Divider />
      <ToolCredentialsSection form={form} embedded />
      <Divider />
      {isFullMode && (
        <>
          <HarnessField form={form} />
          <Divider />
          <AntiHallucinationFields form={form} models={models} />
          <Divider />
          <CitationStrictnessField form={form} />
          <Divider />
        </>
      )}
      <AdaptivePersonaFields form={form} />
      <Divider />
      <VoiceFields
        form={form}
        models={models}
        integrations={integrations}
        selectedModel={selectedModel}
        onClose={onClose}
      />
    </Section>
  );
}

function HistoryNumberField({
  id,
  label,
  description,
  value,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-fg-faint" htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-describedby={`${id}-description`}
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
        className="w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-fg"
      />
      <p id={`${id}-description`} className="min-h-8 text-[10px] leading-snug text-fg-faint">{description}</p>
    </div>
  );
}
