"use client";
import { useState } from "react";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { ModelConfig } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { useModelEditorForm } from "./model-editor/useModelEditorForm";
import { useModelSaveHandlers } from "./model-editor/useModelSaveHandlers";
import { EditorChrome, ExpertToggle } from "./model-editor/EditorChrome";
import { EditorFooter } from "./model-editor/ProbeAndFooter";
import { ModelEditorBody, ModelEditorOverlays } from "./model-editor/ModelEditorBody";

interface Props {
  model?: ModelConfig;
  onSave: (name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) => Promise<void>;
  onClose: () => void;
}

export function ModelEditor({ model, onSave, onClose }: Props) {
  const isFullMode = useAppContext().state.experienceMode === "full";
  // Per-editor opt-in so a normal-mode user can reveal the engine-room
  // fields for one model without flipping the global workspace mode.
  const [showExpert, setShowExpert] = useState(false);
  const expertVisible = isFullMode || showExpert;
  const form = useModelEditorForm(model);
  const h = useModelSaveHandlers({ form, onSave, onClose });
  useEscapeKey(onClose);

  return (
    <EditorChrome
      title={form.isEdit ? "Edit model config" : "New model config"}
      wide={expertVisible}
      onClose={onClose}
      expertToggle={!isFullMode ? <ExpertToggle showExpert={showExpert} onToggle={() => setShowExpert((v) => !v)} /> : null}
      footer={<EditorFooter form={form} onTest={h.handleTestConnection} onSave={h.handleSave} onClose={onClose} />}
      overlays={<ModelEditorOverlays form={form} onConfirmShrink={h.confirmShrinkAndSave} onSkipShrink={h.skipCompactAndSave} />}
    >
      <ModelEditorBody form={form} expertVisible={expertVisible} onLoadCatalog={h.loadCatalog} />
    </EditorChrome>
  );
}
