import { NextRequest } from "next/server";
import { listModelConfigs, upsertModelConfig } from "@/lib/stores/model-config";
import { errorResponse, createdResponse, cachedJson } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

export function GET() {
  return cachedJson(listModelConfigs().map((r) => ({
    ...r,
    params: parseJsonSafe<Record<string, unknown>>(r.params, {}),
    is_default: Boolean(r.is_default),
  })), 15);
}

export async function POST(req: NextRequest) {
  const { name, provider, model_id, params = {}, is_default = false } = await req.json() as {
    name: string; provider: string; model_id: string; params?: Record<string, unknown>; is_default?: boolean;
  };
  if (!name || !provider || !model_id) return errorResponse("name, provider, model_id required");
  const r = upsertModelConfig(name, provider, model_id, params, is_default);
  return createdResponse({
    ...r,
    params: parseJsonSafe<Record<string, unknown>>(r.params, {}),
    is_default: Boolean(r.is_default),
  });
}
