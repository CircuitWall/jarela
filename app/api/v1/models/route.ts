/**
 * @public — `GET /api/v1/models` (list), `POST /api/v1/models` (upsert)
 *
 * Model-config catalog: per-model parameter presets that agents bind to
 * by name (`model_config_name`). See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getModelConfig, isModelConfigEnabled, listModelConfigs, upsertModelConfig, withModelConfigMutation } from "@/lib/stores/model-config";
import { createdResponse, cachedJson, validateBody } from "@/lib/api/responses";
import { preserveInlineModelSecrets, redactInlineModelParams } from "@/lib/models/inline-params";
import { enrichParamsWithDiscoveredContext } from "@/lib/models/discover-context-window";
import { listModelMetadata, resolvedModelMetadata } from "@/lib/stores/model-metadata";

const CreateBody = z.object({
  name: z.string().min(1, "name required"),
  provider: z.string().min(1, "provider required"),
  model_id: z.string().min(1, "model_id required"),
  params: z.record(z.string(), z.unknown()).optional(),
  is_default: z.boolean().optional(),
  credential_id: z.string().nullable().optional(),
});

export function GET() {
  const metadata = listModelMetadata();
  return cachedJson(listModelConfigs().map((r) => ({
    ...r,
    ...resolvedModelMetadata(r.provider, r.model_id, metadata),
    params: redactInlineModelParams(r.params),
    is_default: Boolean(r.is_default),
    enabled: isModelConfigEnabled(r),
  })), 15, 60);
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, CreateBody);
  if (body instanceof NextResponse) return body;
  return withModelConfigMutation(body.name, async () => {
    const safeParams = preserveInlineModelSecrets(body.params ?? {}, getModelConfig(body.name)?.params);
    const enriched = await enrichParamsWithDiscoveredContext(body.provider, body.model_id, safeParams);
    const r = upsertModelConfig(
      body.name,
      body.provider,
      body.model_id,
      enriched,
      body.is_default,
      body.credential_id ?? null,
    );
    return createdResponse({
      ...r,
      ...resolvedModelMetadata(r.provider, r.model_id),
      params: redactInlineModelParams(r.params),
      is_default: Boolean(r.is_default),
      enabled: isModelConfigEnabled(r),
    });
  });
}
