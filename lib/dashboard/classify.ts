// Heuristic model-functionality classifier driving the dashboard's
// functionality filter. Pure so it can be exercised with table-driven tests.

export type ModelFunctionality =
  | "embeddings"
  | "reranking"
  | "moderation"
  | "multimodal"
  | "audio"
  | "coding"
  | "reasoning"
  | "chat"
  | "other";

export function detectModelFunctionality(modelId: string): ModelFunctionality {
  const id = (modelId ?? "").toLowerCase();
  if (/(embed|embedding|text-embedding|voyage-)/.test(id)) return "embeddings";
  if (/(rerank|rank)/.test(id)) return "reranking";
  if (/(moderation|safety)/.test(id)) return "moderation";
  if (/(image|vision|multimodal|omni|vl)/.test(id)) return "multimodal";
  if (/(audio|speech|tts|stt|whisper)/.test(id)) return "audio";
  if (/(code|coder|coding)/.test(id)) return "coding";
  if (/(reason|thinking|r1|o1|o3|deepthink)/.test(id)) return "reasoning";
  if (/(chat|instruct|gpt|claude|gemini|command|llama|mistral|qwen)/.test(id)) return "chat";
  return "other";
}
