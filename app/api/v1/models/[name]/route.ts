import { NextRequest, NextResponse } from "next/server";
import { deleteModelConfig, upsertModelConfig } from "@/lib/stores/model-config";
import { parseJsonSafe } from "@/lib/utils/json";

type Params = { params: Promise<{ name: string }> };

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
  const { provider, model_id, params: p = {}, is_default = false, credential_id = null } = await req.json() as {
    provider: string; model_id: string; params?: Record<string, unknown>;
    is_default?: boolean; credential_id?: string | null;
  };
  const r = upsertModelConfig(name, provider, model_id, p, is_default, credential_id);
  return NextResponse.json({ ...r, params: redactInlineParams(r.params), is_default: Boolean(r.is_default) });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const deleted = deleteModelConfig(name);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
