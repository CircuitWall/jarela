"use client";
import type { ModelConfig } from "@/api/types";
import { useDirty, useDismissGuard } from "@/hooks/useDismissGuard";
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
  const dirty = useDirty({
    name: form.name, provider: form.provider, modelId: form.modelId, apiKey: form.apiKey,
    baseUrl: form.baseUrl, extraHeaders: form.extraHeaders, temperature: form.temperature,
    maxTokens: form.maxTokens, contextWindowTokens: form.contextWindowTokens, isDefault: form.isDefault,
  });
  const requestClose = useDismissGuard({ dirty, busy: form.saving, onClose });

  return (
    <EditorChrome
      title={form.isEdit ? "Edit model config" : "New model config"}
      wide={false}
      onClose={requestClose}
      expertToggle={null}
      footer={<EditorFooter form={form} dirty={dirty} onTest={h.handleTestConnection} onSave={h.handleSave} onCancel={requestClose} onDiscard={onClose} />}
      overlays={<ModelEditorOverlays form={form} onConfirmShrink={h.confirmShrinkAndSave} onSkipShrink={h.skipCompactAndSave} />}
    >
      <ModelEditorBody form={form} onLoadCatalog={h.loadCatalog} />
    </EditorChrome>
  );
}
