"use client";
import { useEffect, useState } from "react";
import type { AgentConfig, AgentConfigIn, ModelConfig } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { useDirty, useDismissGuard } from "@/hooks/useDismissGuard";
import { DialogError, DialogFooter } from "@/components/ui/DialogFooter";
import { useAgentEditorForm } from "./agent-editor/useAgentEditorForm";
import { useAgentSaveHandler } from "./agent-editor/useAgentSaveHandler";
import { IdentitySection } from "./agent-editor/IdentitySection";
import { ModelSection } from "./agent-editor/ModelSection";
import { ToolsSection } from "./agent-editor/ToolsSection";
import { DelegatesSection } from "./agent-editor/DelegatesSection";
import { AdvancedSection } from "./agent-editor/AdvancedSection";
import { EditorChrome } from "./agent-editor/EditorChrome";

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
  // Default tools are merged in after the tool list loads; baseline the
  // dirty check only once that has settled.
  const [settled, setSettled] = useState(false);
  useEffect(() => { if (form.tools.length > 0) setSettled(true); }, [form.tools.length]);
  const dirty = useDirty(form.buildPayload(), settled);
  const requestClose = useDismissGuard({ dirty, busy: saving, onClose });
  return (
    <EditorChrome
      title={agent ? "Edit agent" : "New agent"}
      variant={isFullMode ? "full" : "compact"}
      onClose={requestClose}
      footer={(
        <DialogFooter
          onCancel={requestClose}
          onDiscard={onClose}
          dirty={dirty}
          onSave={handleSave}
          saving={saving}
          canSave={!agent || dirty || !settled}
          start={(
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={form.isDefault}
                onChange={(e) => form.setIsDefault(e.target.checked)}
              />
              <span className="text-xs text-fg-subtle">Set as default agent</span>
            </label>
          )}
        />
      )}
    >
      <IdentitySection form={form} />
      <hr className="border-border" />
      <ModelSection form={form} models={models} integrations={form.integrations} onClose={requestClose} />
      <hr className="border-border" />
      <ToolsSection form={form} advancedMode={isFullMode} />
      <DelegatesSection form={form} />
      <hr className="border-border" />
      <AdvancedSection form={form} models={models} integrations={form.integrations} isFullMode={isFullMode} onClose={requestClose} />
      <DialogError message={error} />
    </EditorChrome>
  );
}
