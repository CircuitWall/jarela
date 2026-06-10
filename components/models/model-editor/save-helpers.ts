import { api } from "@/api/client";
import type { ModelConfig } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { buildModelEditorPayload } from "@/lib/models/editor-payload";
import type { ModelEditorForm } from "./useModelEditorForm";

export function collectInlineOverrides(form: ModelEditorForm): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = {};
  if (form.apiKey.trim()) overrides.api_key = form.apiKey.trim();
  if (form.baseUrl.trim()) overrides.base_url = form.baseUrl.trim();
  if (form.extraHeaders.trim()) {
    try { overrides.extra_headers = JSON.parse(form.extraHeaders); }
    catch { /* invalid JSON — ignore */ }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function buildPayload(form: ModelEditorForm) {
  return buildModelEditorPayload({
    name: form.name,
    provider: form.provider,
    model_id: form.modelId,
    api_key: form.apiKey,
    base_url: form.baseUrl,
    extra_headers: form.extraHeaders,
    temperature: form.temperature,
    max_tokens: form.maxTokens,
    context_window_tokens: form.contextWindowTokens,
    is_default: form.isDefault,
    credential_id: form.credentialId,
  });
}

export async function runProbeStep(
  form: ModelEditorForm,
  payload: Omit<ModelConfig, "name" | "created_at" | "updated_at">,
): Promise<boolean> {
  const probe = await api.models
    .probe(form.provider, payload.model_id, payload.params as Record<string, unknown>, undefined, form.credentialId ?? undefined)
    .catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
  form.setProbeResult(probe);
  if (!probe.ok) {
    form.setError(`Model probe failed: ${probe.error || "unknown error"}. Use "Save anyway" if this is intentional.`);
    form.setAllowSaveAnyway(true);
    form.setSaving(false);
    return false;
  }
  return true;
}

export function shouldStageShrinkConfirm(
  form: ModelEditorForm,
  result: { name: string; payload: Omit<ModelConfig, "name" | "created_at" | "updated_at"> },
): boolean {
  if (!form.model) return false;
  const oldCtx = Number(form.model.params.context_window_tokens) || 0;
  const newCtx = Number(result.payload.params.context_window_tokens) || 0;
  const ctxShrunk = oldCtx > 0 && newCtx > 0 && newCtx < oldCtx;
  const modelIdChanged = form.model.model_id !== result.payload.model_id;
  if (!ctxShrunk && !modelIdChanged) return false;
  form.setPendingShrinkConfirm({
    oldSnapshot: {
      provider: form.model.provider,
      model_id: form.model.model_id,
      params: form.model.params as Record<string, unknown>,
    },
    payloadName: result.name,
    payload: result.payload,
  });
  form.setSaving(false);
  return true;
}

export function toastSaveFail(e: unknown, form: ModelEditorForm, name: string, modelIdResolved: string) {
  pushErrorToast({
    title: "Couldn't save model",
    error: e,
    context: { panel: "models", action: "model.save", name, provider: form.provider, model_id: modelIdResolved },
  });
}
