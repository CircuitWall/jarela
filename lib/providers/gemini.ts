import { makeOpenAICompatProvider } from "./openai";

// Google Gemini via its OpenAI-compatible endpoint.
// Auth: set params.api_key to your Google AI Studio API key.
// Models: gemini-2.0-flash, gemini-2.5-pro, gemini-1.5-flash, etc.
export const geminiProvider = makeOpenAICompatProvider(
  "gemini",
  "https://generativelanguage.googleapis.com/v1beta/openai/",
  {},
);
