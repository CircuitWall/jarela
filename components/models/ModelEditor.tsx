"use client";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { ModelConfig } from "@/api/types";
import { useModelEditorForm } from "./model-editor/useModelEditorForm";
import { useModelSaveHandlers } from "./model-editor/useModelSaveHandlers";
import { EditorChrome } from "./model-editor/EditorChrome";
import { EditorFooter } from "./model-editor/ProbeAndFooter";
import { ModelEditorBody, ModelEditorOverlays } from "./model-editor/ModelEditorBody";

interface Props {
  model?: ModelConfig;
  onSave: (name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) => Promise<void>;
  onClose: () => void;
}

export function ModelEditor({ model, onSave, onClose }: Props) {
  const form = useModelEditorForm(model);
  const h = useModelSaveHandlers({ form, onSave, onClose });
  useEscapeKey(onClose);

  return (
    <EditorChrome
      title={form.isEdit ? "Edit model config" : "New model config"}
      wide={false}
      onClose={onClose}
      expertToggle={null}
      footer={<EditorFooter form={form} onTest={h.handleTestConnection} onSave={h.handleSave} onClose={onClose} />}
      overlays={<ModelEditorOverlays form={form} onConfirmShrink={h.confirmShrinkAndSave} onSkipShrink={h.skipCompactAndSave} />}
    >
      <ModelEditorBody form={form} onLoadCatalog={h.loadCatalog} />
    </EditorChrome>
  );
}
