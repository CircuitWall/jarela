import type { ModelConfig } from "@/api/types";
import {
  useCatalogState, useCredentialState, useIdentityState,
  useIntegrationsState, useParamsState, useStatusState,
} from "./form-state";

export type ShrinkPending =
  | null
  | {
      oldSnapshot: { provider: string; model_id: string; params: Record<string, unknown> };
      payloadName: string;
      payload: Omit<ModelConfig, "name" | "created_at" | "updated_at">;
    };

export type ProbeResult = { ok: boolean; error?: string } | null;

export type ModelEditorForm = ReturnType<typeof useModelEditorForm>;

export function useModelEditorForm(model: ModelConfig | undefined) {
  const id = useIdentityState(model);
  const cred = useCredentialState(model, id.provider, id.isEdit);
  const params = useParamsState(model);
  const status = useStatusState();
  const catalog = useCatalogState(id.provider);
  const integ = useIntegrationsState();
  return { ...id, ...cred, ...params, ...status, ...catalog, ...integ };
}
