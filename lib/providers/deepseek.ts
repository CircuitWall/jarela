import { makeOpenAICompatProvider } from "./openai";

// DeepSeek API is OpenAI-compatible. Reasoning models (deepseek-reasoner, etc.)
// emit `reasoning_content` in delta chunks — handled by the shared OpenAI stream parser.
// Auth: set params.api_key to your DeepSeek API key.
export const deepseekProvider = makeOpenAICompatProvider(
  "deepseek",
  "https://api.deepseek.com",
  {},
);
