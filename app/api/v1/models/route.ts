/**
 * @public — `GET /api/v1/models` (list), `POST /api/v1/models` (upsert)
 *
 * Model-config catalog: per-model parameter presets that agents bind to
 * by name (`model_config_name`). See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getModelConfig, listModelConfigs, upsertModelConfig } from "@/lib/stores/model-config";
import { createdResponse, cachedJson, validateBody } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

const CreateBody = z.object({
  name: z.string().min(1, "name required"),
  provider: z.string().min(1, "provider required"),
  model_id: z.string().min(1, "model_id required"),
  params: z.record(z.string(), z.unknown()).optional(),
  is_default: z.boolean().optional(),
  credential_id: z.string().nullable().optional(),
});

// Fields that must never leave the server in plaintext. Inline values
// (e.g. lingering on rows that haven't been migrated to credentials yet)
// are redacted to "***" so clients can detect presence without seeing
// the secret. Authoritative secrets live in `credentials.params` and
// are served exclusively via `/api/v1/credentials`.
const SECRET_FIELDS = new Set(["api_key", "client_secret", "refresh_token", "access_token"]);
// Sentinels the client may echo back when the user did not change a
// previously-redacted secret field. The model PUT/POST routes preserve
// the existing value for any field whose incoming value matches one of
// these — without it, re-saving from the setup wizard would clobber a
// real key with the literal "***" string.
const SECRET_SENTINELS = new Set(["***", "********"]);

function redactInlineParams(raw: string): Record<string, unknown> {
  const parsed = parseJsonSafe<Record<string, unknown>>(raw, {});
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (SECRET_FIELDS.has(k)) safe[k] = typeof v === "string" && v.length > 0 ? "***" : v;
    else safe[k] = v;
  }
  return safe;
}

function preserveSecrets(name: string, incoming: Record<string, unknown>): Record<string, unknown> {
  const existing = getModelConfig(name);
  if (!existing) return incoming;
  const existingParams = parseJsonSafe<Record<string, unknown>>(existing.params, {});
  const out: Record<string, unknown> = { ...incoming };
  for (const field of SECRET_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && SECRET_SENTINELS.has(v)) {
      const prior = existingParams[field];
      if (typeof prior === "string" && prior.length > 0) out[field] = prior;
      else delete out[field];
    }
  }
  return out;
}

export function GET() {
  return cachedJson(listModelConfigs().map((r) => ({
    ...r,
    params: redactInlineParams(r.params),
    is_default: Boolean(r.is_default),
  })), 15);
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, CreateBody);
  if (body instanceof NextResponse) return body;
  const safeParams = preserveSecrets(body.name, body.params ?? {});
  const r = upsertModelConfig(
    body.name,
    body.provider,
    body.model_id,
    safeParams,
    body.is_default ?? false,
    body.credential_id ?? null,
  );
  return createdResponse({
    ...r,
    params: redactInlineParams(r.params),
    is_default: Boolean(r.is_default),
  });
}
