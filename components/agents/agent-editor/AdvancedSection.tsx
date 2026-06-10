import type { IntegrationStatus, ModelConfig } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";
import { HarnessField } from "./HarnessField";
import { AntiHallucinationFields, CitationStrictnessField } from "./HallucinationFields";
import { TierOverrideField } from "./TierOverrideField";
import { AdaptivePersonaFields } from "./AdaptivePersonaFields";
import { VoiceFields } from "./VoiceFields";

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
    <Section step={4} title="Advanced settings">
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
      <TierOverrideField form={form} selectedModel={selectedModel} />
      <Divider />
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
