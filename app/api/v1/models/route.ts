import { NextRequest, NextResponse } from "next/server";
import { listModelConfigs, upsertModelConfig } from "@/lib/stores/model-config";

export function GET() {
  return NextResponse.json(listModelConfigs().map((r) => ({ ...r, params: JSON.parse(r.params), is_default: Boolean(r.is_default) })));
}

export async function POST(req: NextRequest) {
  const { name, provider, model_id, params = {}, is_default = false } = await req.json() as {
    name: string; provider: string; model_id: string; params?: Record<string, unknown>; is_default?: boolean;
  };
  if (!name || !provider || !model_id) return NextResponse.json({ error: "name, provider, model_id required" }, { status: 400 });
  const r = upsertModelConfig(name, provider, model_id, params, is_default);
  return NextResponse.json({ ...r, params: JSON.parse(r.params), is_default: Boolean(r.is_default) }, { status: 201 });
}
