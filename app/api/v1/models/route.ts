/**
 * @public — `GET /api/v1/models` (list), `POST /api/v1/models` (upsert)
 *
 * Model-config catalog: per-model parameter presets that agents bind to
 * by name (`model_config_name`). See `docs/api.md`.
 */

import { NextRequest } from "next/server";
import { listModelConfigs, upsertModelConfig } from "@/lib/stores/model-config";
import { errorResponse, createdResponse, cachedJson } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

// Fields that must never leave the server in plaintext. Inline values
// (e.g. lingering on rows that haven't been migrated to credentials yet)
// are redacted to "***" so clients can detect presence without seeing
// the secret. Authoritative secrets live in `credentials.params` and
// are served exclusively via `/api/v1/credentials`.
const SECRET_FIELDS = new Set(["api_key", "client_secret", "refresh_token", "access_token"]);

function redactInlineParams(raw: string): Record<string, unknown> {
  const parsed = parseJsonSafe<Record<string, unknown>>(raw, {});
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (SECRET_FIELDS.has(k)) safe[k] = typeof v === "string" && v.length > 0 ? "***" : v;
    else safe[k] = v;
  }
  return safe;
}

export function GET() {
  return cachedJson(listModelConfigs().map((r) => ({
    ...r,
    params: redactInlineParams(r.params),
    is_default: Boolean(r.is_default),
  })), 15);
}

export async function POST(req: NextRequest) {
  const { name, provider, model_id, params = {}, is_default = false, credential_id = null } = await req.json() as {
    name: string; provider: string; model_id: string; params?: Record<string, unknown>;
    is_default?: boolean; credential_id?: string | null;
  };
  if (!name || !provider || !model_id) return errorResponse("name, provider, model_id required");
  const r = upsertModelConfig(name, provider, model_id, params, is_default, credential_id);
  return createdResponse({
    ...r,
    params: redactInlineParams(r.params),
    is_default: Boolean(r.is_default),
  });
}
