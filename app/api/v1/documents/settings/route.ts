import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getEmbeddingModelConfigName,
  setEmbeddingModelConfigName,
  setDocumentLocalEmbeddings,
  isDocumentLocalEmbeddingsEnabled,
} from "@/lib/stores/app-settings";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import type { ProviderParams } from "@/lib/providers/types";
import { errorMessage } from "@/lib/utils/error";
import { validateBody } from "@/lib/api/responses";
import { LOCAL_EMBEDDING_CONFIG_NAME, LOCAL_EMBEDDING_MODEL_ID, LOCAL_EMBEDDING_PROVIDER_NAME } from "@/lib/embeddings/constants";
import { embedLocally } from "@/lib/embeddings/local";

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
  if (name === LOCAL_EMBEDDING_CONFIG_NAME) {
    try {
      const [vector] = await embedLocally(["Jarela local embedding capability probe"], "query");
      return {
        ok: true,
        provider: LOCAL_EMBEDDING_PROVIDER_NAME,
        model_id: LOCAL_EMBEDDING_MODEL_ID,
        dimension: vector.length,
      };
    } catch (err) {
      return {
        ok: false,
        provider: LOCAL_EMBEDDING_PROVIDER_NAME,
        model_id: LOCAL_EMBEDDING_MODEL_ID,
        error: errorMessage(err),
      };
    }
  }
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
  const selected = isDocumentLocalEmbeddingsEnabled()
    ? LOCAL_EMBEDDING_CONFIG_NAME
    : getEmbeddingModelConfigName();
  return NextResponse.json({
    embedding_model_config: selected,
    embedding_probe: await probeEmbeddingModelConfig(selected),
  });
}

export async function PUT(req: NextRequest) {
  const parsed = await validateBody(req, PutSchema);
  if (parsed instanceof NextResponse) return parsed;
  const name = parsed.embedding_model_config;
  if (name && name !== LOCAL_EMBEDDING_CONFIG_NAME && !getModelConfig(name)) {
    return NextResponse.json({ error: `unknown model config: ${name}` }, { status: 400 });
  }
  const selected = name === LOCAL_EMBEDDING_CONFIG_NAME
    ? (setDocumentLocalEmbeddings(true), LOCAL_EMBEDDING_CONFIG_NAME)
    : (setDocumentLocalEmbeddings(false), setEmbeddingModelConfigName(name));
  return NextResponse.json({
    embedding_model_config: selected,
    embedding_probe: await probeEmbeddingModelConfig(selected),
  });
}
