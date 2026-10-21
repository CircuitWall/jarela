"use client";
import { useEffect, useRef } from "react";
import type { ModelConfig } from "@/api/types";
import { useDirty, useDismissGuard } from "@/hooks/useDismissGuard";
import { useModelEditorForm } from "./model-editor/useModelEditorForm";
import { useModelSaveHandlers } from "./model-editor/useModelSaveHandlers";
import { EditorChrome } from "./model-editor/EditorChrome";
import { EditorFooter } from "./model-editor/ProbeAndFooter";
import { ModelEditorBody, ModelEditorOverlays } from "./model-editor/ModelEditorBody";

interface Props {
  model?: ModelConfig;
  initialProvider?: string;
  autoLoadCatalog?: boolean;
  onSave: (name: string, data: Omit<ModelConfig, "name" | "enabled" | "created_at" | "updated_at">) => Promise<void>;
  onClose: () => void;
}

export function ModelEditor({ model, initialProvider, autoLoadCatalog = false, onSave, onClose }: Props) {
  const form = useModelEditorForm(model, initialProvider);
  const h = useModelSaveHandlers({ form, onSave, onClose });
  const loadCatalog = h.loadCatalog;
  const autoLoadStarted = useRef(false);
  const dirty = useDirty({
    name: form.name, provider: form.provider, modelId: form.modelId, apiKey: form.apiKey,
    baseUrl: form.baseUrl, extraHeaders: form.extraHeaders, temperature: form.temperature,
    maxTokens: form.maxTokens, contextWindowTokens: form.contextWindowTokens, isDefault: form.isDefault,
  });
  const requestClose = useDismissGuard({ dirty, busy: form.saving, onClose });

  useEffect(() => {
    if (model || !autoLoadCatalog || autoLoadStarted.current) return;
    autoLoadStarted.current = true;
    void loadCatalog();
  }, [autoLoadCatalog, loadCatalog, model]);

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
