import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteModelConfig,
  getModelConfig,
  isModelConfigEnabled,
  ModelConfigStateError,
  setDefaultModelConfig,
  setModelConfigEnabled,
  upsertModelConfig,
  withModelConfigMutation,
} from "@/lib/stores/model-config";
import { withDbTransaction } from "@/lib/db/transaction";
import { validateBody, errorJson, errorResponse } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";
import { enrichParamsWithDiscoveredContext } from "@/lib/models/discover-context-window";
import { resolvedModelMetadata } from "@/lib/stores/model-metadata";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ name: string }> };

const PutBody = z.object({
  provider: z.string().min(1, "provider required"),
  model_id: z.string().min(1, "model_id required"),
  params: z.record(z.string(), z.unknown()).optional(),
  is_default: z.boolean().optional(),
  credential_id: z.string().nullable().optional(),
});

// Targeted state changes that must not re-send (and re-process) the whole
// config. Each request is applied in a single transaction.
const PatchBody = z.object({
  enabled: z.boolean().optional(),
  is_default: z.literal(true).optional(),
}).strict().refine((b) => b.enabled !== undefined || b.is_default !== undefined, {
  message: "provide enabled and/or is_default",
}).refine((b) => !(b.enabled === false && b.is_default === true), {
  message: "a disabled model cannot be the default",
});

// Mirror /api/v1/models GET: never echo plaintext secrets back to the
// client. Authoritative storage lives in `credentials`; per-model rows
// retain only non-secret overrides post-migration.
const SECRET_FIELDS = new Set(["api_key", "client_secret", "refresh_token", "access_token"]);
// Sentinels the client may echo back when the user did not change a
// previously-redacted secret field. Preserve the existing stored value
// for any field whose incoming value matches one of these — otherwise
// a re-save from the setup wizard would overwrite a real key with the
// literal "***" string.
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

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  return withModelConfigMutation(name, async () => {
    const safeParams = preserveSecrets(name, body.params ?? {});
    const enriched = await enrichParamsWithDiscoveredContext(body.provider, body.model_id, safeParams);
    const r = upsertModelConfig(
      name,
      body.provider,
      body.model_id,
      enriched,
      body.is_default,
      body.credential_id ?? null,
    );
    return NextResponse.json(toResponse(r));
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const body = await validateBody(req, PatchBody);
  if (body instanceof NextResponse) return body;
  try {
    const r = withDbTransaction(() => {
      let row = getModelConfig(name);
      if (!row) throw new ModelConfigStateError(`Model config "${name}" not found`, 404);
      if (body.enabled !== undefined) row = setModelConfigEnabled(name, body.enabled);
      if (body.is_default) row = setDefaultModelConfig(name);
      return row;
    });
    return NextResponse.json(toResponse(r));
  } catch (err) {
    if (err instanceof ModelConfigStateError) {
      return errorJson({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

function toResponse(r: NonNullable<ReturnType<typeof getModelConfig>>) {
  return {
    ...r,
    ...resolvedModelMetadata(r.provider, r.model_id),
    params: redactInlineParams(r.params),
    is_default: Boolean(r.is_default),
    enabled: isModelConfigEnabled(r),
  };
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  return withModelConfigMutation(name, () => {
    const deleted = deleteModelConfig(name);
    if (!deleted) return errorResponse(NOT_FOUND_ERRORS.DEFAULT, 404);
    return NextResponse.json({ deleted: true });
  });
}
