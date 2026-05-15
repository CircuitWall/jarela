import { NextRequest, NextResponse } from "next/server";
import { deleteModelConfig, upsertModelConfig } from "@/lib/stores/model-config";

type Params = { params: Promise<{ name: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const { provider, model_id, params: p = {}, is_default = false } = await req.json() as {
    provider: string; model_id: string; params?: Record<string, unknown>; is_default?: boolean;
  };
  const r = upsertModelConfig(name, provider, model_id, p, is_default);
  return NextResponse.json({ ...r, params: JSON.parse(r.params), is_default: Boolean(r.is_default) });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const deleted = deleteModelConfig(name);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
