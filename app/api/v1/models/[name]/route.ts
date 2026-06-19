import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteModelConfig, getModelConfig, upsertModelConfig } from "@/lib/stores/model-config";
import { validateBody } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

type Params = { params: Promise<{ name: string }> };

const PutBody = z.object({
  provider: z.string().min(1, "provider required"),
  model_id: z.string().min(1, "model_id required"),
  params: z.record(z.string(), z.unknown()).optional(),
  is_default: z.boolean().optional(),
  credential_id: z.string().nullable().optional(),
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
  const safeParams = preserveSecrets(name, body.params ?? {});
  const r = upsertModelConfig(
    name,
    body.provider,
    body.model_id,
    safeParams,
    body.is_default ?? false,
    body.credential_id ?? null,
  );
  return NextResponse.json({ ...r, params: redactInlineParams(r.params), is_default: Boolean(r.is_default) });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const deleted = deleteModelConfig(name);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
