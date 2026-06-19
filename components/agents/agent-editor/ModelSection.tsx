import type { ModelConfig } from "@/api/types";
import { isProviderClassified, modelSupportsImages } from "@/lib/providers/capabilities";
import { CapBadges } from "@/components/models/CapBadges";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { Select } from "@/components/ui/Select";
import { useAppContext } from "@/contexts/AppContext";
import { computeFeatureReadiness } from "@/lib/ui/feature-readiness";
import type { IntegrationStatus } from "@/api/types";
import type { AgentEditorForm } from "./useAgentEditorForm";
import { Section } from "./Section";

interface Props {
  form: AgentEditorForm;
  models: ModelConfig[];
  integrations: IntegrationStatus[];
  onClose: () => void;
}

export function ModelSection({ form, models, integrations, onClose }: Props) {
  const { dispatch } = useAppContext();
  const selectedModel = models.find((m) => m.name === form.modelConfigName);
  const defaultModel = models.find((m) => m.is_default);
  const readiness = computeFeatureReadiness({
    models,
    integrations,
    selectedProvider: selectedModel?.provider,
    selectedModelId: selectedModel?.model_id,
  });

  return (
    <Section step={2} title="Model">
      {!readiness.documentsReady && (
        <DocumentsReadinessNotice onOpenModels={() => { onClose(); dispatch({ type: "SET_TAB", tab: "models" }); }} />
      )}
      <Select value={form.modelConfigName} onChange={(e) => form.setModelConfigName(e.target.value)}>
        <option value="">
          {defaultModel
            ? `Default (${defaultModel.name} · ${defaultModel.model_id})${modelSupportsImages(defaultModel.provider, defaultModel.model_id) ? " 📷" : ""}`
            : "(no default configured)"}
        </option>
        {models.map((m) => {
          // Prefix with a camera glyph when the model is known to accept
          // image inputs — surfaces "this agent can read images" without
          // a separate column. Plain <option> can't hold an SVG.
          const vision = modelSupportsImages(m.provider, m.model_id);
          return (
            <option key={m.name} value={m.name}>
              {vision ? "📷 " : ""}{m.name} · {m.provider} / {m.model_id}
            </option>
          );
        })}
      </Select>
      {selectedModel && <SelectedModelDescription model={selectedModel} />}
      {models.length === 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">No model configs yet — go to the Models panel to add one first.</p>
      )}
    </Section>
  );
}

function DocumentsReadinessNotice({ onOpenModels }: { onOpenModels: () => void }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
      <p>Add a model config that the current installation can use for Documents embeddings if you want semantic document recall.</p>
      <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
        Compatible setup: OpenAI, Gemini, and GitHub Copilot-backed setups are the main built-in paths for embeddings without introducing another billing surface.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpenModels}
          className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
        >
          Open Models
        </button>
      </div>
    </div>
  );
}

function SelectedModelDescription({ model }: { model: ModelConfig }) {
  return (
    <div className="space-y-1">
      <p className="inline-flex items-center gap-1.5 text-[11px] text-fg-faint">
        <span className="text-fg-subtle"><ProviderLogo name={model.provider} size={12} /></span>
        Using <span className="text-fg-subtle">{model.provider}</span> / <span className="font-mono text-fg-muted">{model.model_id}</span>
        {!modelSupportsImages(model.provider, model.model_id) && (
          isProviderClassified(model.provider)
            ? <span className="ml-1 text-amber-700 dark:text-amber-300">· no image input</span>
            : <span className="ml-1 text-fg-faint">· capabilities unknown</span>
        )}
      </p>
      <CapBadges provider={model.provider} modelId={model.model_id} />
    </div>
  );
}
