import { makeOpenAICompatProvider } from "./openai";
import type { ModelProvider, ProviderParams } from "./types";

// Google Gemini via its OpenAI-compatible endpoint.
// Auth: set params.api_key to your Google AI Studio API key.
// Models: gemini-2.0-flash, gemini-2.5-pro, gemini-1.5-flash, etc.
const geminiCompat = makeOpenAICompatProvider(
  "gemini",
  "https://generativelanguage.googleapis.com/v1beta/openai/",
  {},
);

function resolveGeminiEmbeddingModel(model_id: string, params: ProviderParams): string {
  const overridden = (params as Record<string, unknown>).embedding_model_id;
  if (typeof overridden === "string" && overridden.trim()) return overridden.trim();
  // When chat model ids (gemini-*) are passed into embed(), switch to a
  // dedicated embedding model by default.
  if (/^gemini-/i.test(model_id)) return "text-embedding-004";
  return model_id;
}

async function geminiEmbed(model_id: string, inputs: string[], params: ProviderParams): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const apiKey = typeof params.api_key === "string" ? params.api_key : process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini: no api_key configured");

  const model = resolveGeminiEmbeddingModel(model_id, params);
  const body = {
    requests: inputs.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    })),
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini embeddings error: ${res.status} ${msg}`);
  }
  const data = await res.json() as {
    embeddings?: Array<{ values?: number[] }>;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(data.error.message);
  const vectors = (data.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== inputs.length) {
    throw new Error(`Gemini embeddings returned ${vectors.length}/${inputs.length} vectors`);
  }
  return vectors;
}

export const geminiProvider: ModelProvider = {
  ...geminiCompat,
  async embed(model_id, inputs, params): Promise<number[][]> {
    return geminiEmbed(model_id, inputs, params);
  },
};
