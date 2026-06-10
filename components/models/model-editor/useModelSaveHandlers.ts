import { api } from "@/api/client";
import type { ModelConfig } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import type { ModelEditorForm } from "./useModelEditorForm";
import {
  buildPayload,
  collectInlineOverrides,
  runProbeStep,
  shouldStageShrinkConfirm,
  toastSaveFail,
} from "./save-helpers";

interface Args {
  form: ModelEditorForm;
  onSave: (name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) => Promise<void>;
  onClose: () => void;
}

export function useModelSaveHandlers({ form, onSave, onClose }: Args) {
  const loadCatalog = () => loadCatalogAction(form);
  const handleTestConnection = () => testConnectionAction(form);
  const handleSave = () => saveAction(form, onSave, onClose);
  const confirmShrinkAndSave = () => confirmShrinkAction(form, onSave, onClose);
  const skipCompactAndSave = () => skipCompactAction(form, onSave, onClose);
  return { loadCatalog, handleSave, handleTestConnection, confirmShrinkAndSave, skipCompactAndSave };
}

async function loadCatalogAction(form: ModelEditorForm) {
  form.setCatalogLoading(true);
  form.setCatalogError(null);
  try {
    const models = await api.models.catalog(form.provider, collectInlineOverrides(form));
    form.setCatalog(models);
    form.setShowCatalog(true);
  } catch (e) {
    form.setCatalogError(String(e));
    pushErrorToast({
      title: "Couldn't load model catalog",
      error: e,
      context: { panel: "models", action: "catalog.load", provider: form.provider },
    });
  } finally {
    form.setCatalogLoading(false);
  }
}

async function testConnectionAction(form: ModelEditorForm) {
  form.setProbeResult(null);
  if (!form.modelId.trim()) { form.setProbeResult({ ok: false, error: "model_id required" }); return; }
  form.setProbing(true);
  try {
    const res = await api.models.probe(
      form.provider, form.modelId.trim(), collectInlineOverrides(form),
      form.isEdit ? form.model?.name : undefined,
      form.credentialId ?? undefined,
    );
    form.setProbeResult(res);
    if (res.ok) form.setAllowSaveAnyway(false);
  } catch (e) {
    form.setProbeResult({ ok: false, error: String(e instanceof Error ? e.message : e) });
  } finally {
    form.setProbing(false);
  }
}

async function saveAction(form: ModelEditorForm, onSave: Args["onSave"], onClose: Args["onClose"]) {
  form.setError(null);
  const result = buildPayload(form);
  if (!result.ok) { form.setError(result.error); return; }
  form.setSaving(true);
  try {
    if (!form.allowSaveAnyway && !(await runProbeStep(form, result.payload))) return;
    if (form.isEdit && form.model && shouldStageShrinkConfirm(form, result)) return;
    await onSave(result.name, result.payload);
    onClose();
  } catch (e) { toastSaveFail(e, form, result.name, result.payload.model_id); }
  finally { form.setSaving(false); }
}

async function confirmShrinkAction(form: ModelEditorForm, onSave: Args["onSave"], onClose: Args["onClose"]) {
  if (!form.pendingShrinkConfirm) return;
  const { oldSnapshot, payloadName, payload } = form.pendingShrinkConfirm;
  form.setCompacting(true);
  try {
    await api.models.compactThreads(payloadName, oldSnapshot);
    await onSave(payloadName, payload);
    form.setPendingShrinkConfirm(null);
    onClose();
  } catch (e) {
    pushErrorToast({
      title: "Couldn't compact threads before model swap",
      error: e,
      context: { panel: "models", action: "model.compact", name: payloadName },
    });
  } finally { form.setCompacting(false); }
}

async function skipCompactAction(form: ModelEditorForm, onSave: Args["onSave"], onClose: Args["onClose"]) {
  if (!form.pendingShrinkConfirm) return;
  const { payloadName, payload } = form.pendingShrinkConfirm;
  form.setSaving(true);
  try {
    await onSave(payloadName, payload);
    form.setPendingShrinkConfirm(null);
    onClose();
  } catch (e) { toastSaveFail(e, form, payloadName, payload.model_id); }
  finally { form.setSaving(false); }
}
