import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteModelConfig, upsertModelConfig } from "@/lib/stores/model-config";
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
function redactInlineParams(raw: string): Record<string, unknown> {
  const parsed = parseJsonSafe<Record<string, unknown>>(raw, {});
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (SECRET_FIELDS.has(k)) safe[k] = typeof v === "string" && v.length > 0 ? "***" : v;
    else safe[k] = v;
  }
  return safe;
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  const r = upsertModelConfig(
    name,
    body.provider,
    body.model_id,
    body.params ?? {},
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
