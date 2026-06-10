"use client";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { AgentConfig, AgentConfigIn, ModelConfig } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { useAgentEditorForm } from "./agent-editor/useAgentEditorForm";
import { useAgentSaveHandler } from "./agent-editor/useAgentSaveHandler";
import { IdentitySection } from "./agent-editor/IdentitySection";
import { ModelSection } from "./agent-editor/ModelSection";
import { ToolsSection } from "./agent-editor/ToolsSection";
import { DelegatesSection } from "./agent-editor/DelegatesSection";
import { AdvancedSection } from "./agent-editor/AdvancedSection";
import { EditorChrome, EditorFooter } from "./agent-editor/EditorChrome";

interface Props {
  agent?: AgentConfig;
  models: ModelConfig[];
  onSave: (data: AgentConfigIn) => Promise<void>;
  onClose: () => void;
}

export function AgentEditor({ agent, models, onSave, onClose }: Props) {
  const isFullMode = useAppContext().state.experienceMode === "full";
  const form = useAgentEditorForm(agent);
  const { saving, error, handleSave } = useAgentSaveHandler({
    buildPayload: form.buildPayload, getName: () => form.name, onSave, onClose,
  });
  useEscapeKey(onClose);
  return (
    <EditorChrome
      title={agent ? "Edit agent" : "New agent"}
      variant={isFullMode ? "full" : "compact"}
      onClose={onClose}
      footer={<EditorFooter isDefault={form.isDefault} onIsDefaultChange={form.setIsDefault} saving={saving} onSave={handleSave} onClose={onClose} />}
    >
      <IdentitySection form={form} />
      <hr className="border-border" />
      <ModelSection form={form} models={models} integrations={form.integrations} onClose={onClose} />
      <hr className="border-border" />
      <ToolsSection form={form} advancedMode={isFullMode} />
      <DelegatesSection form={form} />
      <hr className="border-border" />
      <AdvancedSection form={form} models={models} integrations={form.integrations} isFullMode={isFullMode} onClose={onClose} />
      {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
    </EditorChrome>
  );
}
