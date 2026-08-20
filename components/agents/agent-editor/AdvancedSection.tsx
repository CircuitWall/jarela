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
import { SelectedModelDescription } from "./ModelSection";

interface Props {
  form: AgentEditorForm;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
  isFullMode: boolean;
  onClose: () => void;
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
          {models.map((m) => {
            const vision = modelSupportsImages(m.provider, m.model_id);
            return (
              <option key={m.name} value={m.name}>
                {vision ? "📷 " : ""}{m.name} · {m.provider} / {m.model_id}
              </option>
            );
          })}
        </Select>
        {selectedModel && <SelectedModelDescription model={selectedModel} prefix="Forced" />}
      </div>
      <Divider />
      <TierOverrideField form={form} selectedModel={selectedModel} />
      <Divider />
      <ToolCredentialsSection form={form} embedded />
      {!form.modelConfigName && (
        <>
          <Divider />
          <div className="space-y-2">
            <p className="text-[11px] text-fg-subtle leading-snug font-medium">Automatic routing</p>
            <p className="text-[10px] text-fg-faint leading-snug">
              Controls whether this agent uses the heuristic model router and which cost/quality policy it applies.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[10px] text-fg-faint">Routing</label>
                <Select
                  value={form.routerEnabled === null ? "" : form.routerEnabled ? "on" : "off"}
                  onChange={(e) => {
                    const v = e.target.value;
                    form.setRouterEnabled(v === "" ? null : v === "on");
                  }}
                >
                  <option value="">Inherit global setting</option>
                  <option value="on">Always route</option>
                  <option value="off">Never route (use default model)</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-fg-faint">Policy</label>
                <Select
                  value={form.routerPolicy}
                  onChange={(e) => form.setRouterPolicy(e.target.value as typeof form.routerPolicy)}
                  disabled={form.routerEnabled === false}
                >
                  <option value="">Inherit global policy</option>
                  <option value="cheap">Cheap — minimize cost</option>
                  <option value="fast">Fast — minimize latency</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality — maximize capability</option>
                </Select>
              </div>
            </div>
          </div>
        </>
      )}
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
