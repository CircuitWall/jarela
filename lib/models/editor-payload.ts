import type { ModelConfig } from "@/api/types";

// Pure helper that turns the model editor's raw form fields (all strings,
// as React state) into the validated payload that ModelsPanel hands off
// to `api.models.create` / `api.models.update`. Lifted out of the
// component so it can be unit-tested without spinning up a React/jsdom
// environment.

export interface ModelEditorFormInput {
  name: string;
  provider: string;
  model_id: string;
  api_key: string;
  base_url: string;
  extra_headers: string;        // JSON text or empty
  temperature: string;          // numeric text or empty
  max_tokens: string;           // numeric text or empty
  context_window_tokens: string; // numeric text or empty
  is_default: boolean;
  // Reference to a row in the typed credentials store. The credential
  // carries api_key / base_url / extra_headers; inline values on the
  // model (above) act as per-model overrides only and are typically
  // empty when a credential is bound.
  credential_id?: string | null;
}

export type ModelEditorPayload = Omit<ModelConfig, "name" | "created_at" | "updated_at">;

export type BuildResult =
  | { ok: true; name: string; payload: ModelEditorPayload }
  | { ok: false; error: string };

function toNumberOrUndefined(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function buildModelEditorPayload(input: ModelEditorFormInput): BuildResult {
  const name = input.name.trim();
  const model_id = input.model_id.trim();
  if (!name || !model_id) return { ok: false, error: "Name and model ID are required" };

  let parsed_headers: Record<string, string> | undefined;
  if (input.extra_headers.trim()) {
    try {
      const parsed = JSON.parse(input.extra_headers);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "Extra headers must be a JSON object" };
      }
      parsed_headers = parsed as Record<string, string>;
    } catch {
      return { ok: false, error: "Extra headers must be valid JSON" };
    }
  }

  const params: ModelConfig["params"] = {};
  if (input.api_key) params.api_key = input.api_key;
  if (input.base_url) params.base_url = input.base_url;
  if (parsed_headers) params.extra_headers = parsed_headers;

  const temp = toNumberOrUndefined(input.temperature);
  if (temp !== undefined) params.temperature = temp;

  const maxT = toNumberOrUndefined(input.max_tokens);
  if (maxT !== undefined) params.max_tokens = maxT;

  const win = toNumberOrUndefined(input.context_window_tokens);
  if (win !== undefined && win > 0) params.context_window_tokens = Math.floor(win);

  return {
    ok: true,
    name,
    payload: {
      provider: input.provider,
      model_id,
      params,
      is_default: input.is_default,
      credential_id: input.credential_id ?? null,
    },
  };
}
