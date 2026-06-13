import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEmbeddingModelConfigName, setEmbeddingModelConfigName } from "@/lib/stores/app-settings";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import type { ProviderParams } from "@/lib/providers/types";
import { errorMessage } from "@/lib/utils/error";

const PutSchema = z.object({
  embedding_model_config: z.string().min(1).nullable(),
});

function isChatModelId(id: string): boolean {
  return /^(gpt-|claude-|deepseek-chat|deepseek-reasoner)/.test(id);
}

function resolveProbeModelId(modelId: string, params: ProviderParams): string {
  const overridden = (params as Record<string, unknown>).embedding_model_id;
  if (typeof overridden === "string" && overridden.trim()) return overridden.trim();
  if (isChatModelId(modelId)) return "text-embedding-3-small";
  return modelId;
}

async function probeEmbeddingModelConfig(name: string | null) {
  if (!name) return null;
  const cfg = getModelConfig(name);
  if (!cfg) {
    return { ok: false, provider: "", model_id: "", error: `unknown model config: ${name}` };
  }
  const params: ProviderParams = getModelParams(cfg);

  const provider = getProvider(cfg.provider);
  if (!provider.embed) {
    return {
      ok: false,
      provider: cfg.provider,
      model_id: cfg.model_id,
      error: `provider ${cfg.provider} does not expose embeddings`,
    };
  }

  const modelId = resolveProbeModelId(cfg.model_id, params);
  try {
    const out = await provider.embed(modelId, ["embedding capability probe"], params);
    const first = out[0];
    if (!first || !Array.isArray(first) || first.length === 0) {
      return {
        ok: false,
        provider: cfg.provider,
        model_id: modelId,
        error: "embedding API returned an empty vector",
      };
    }
    return {
      ok: true,
      provider: cfg.provider,
      model_id: modelId,
      dimension: first.length,
    };
  } catch (err) {
    return {
      ok: false,
      provider: cfg.provider,
      model_id: modelId,
      error: errorMessage(err),
    };
  }
}

export async function GET() {
  const selected = getEmbeddingModelConfigName();
  return NextResponse.json({
    embedding_model_config: selected,
    embedding_probe: await probeEmbeddingModelConfig(selected),
  });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const name = parsed.data.embedding_model_config;
  if (name && !getModelConfig(name)) {
    return NextResponse.json({ error: `unknown model config: ${name}` }, { status: 400 });
  }
  const selected = setEmbeddingModelConfigName(name);
  return NextResponse.json({
    embedding_model_config: selected,
    embedding_probe: await probeEmbeddingModelConfig(selected),
  });
}
