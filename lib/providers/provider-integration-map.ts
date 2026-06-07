// Maps a built-in provider name (anthropic, openai, gemini, …) to its
// matching integration credential name in the INTEGRATIONS manifest.
// Pure data — safe to import from both client and server code.
//
// Most providers use their own name as the integration name. Gemini is
// the exception: its credential lives under "google" because the same
// API key powers both Gemini chat models and the Imagen generate_image
// tool.

export const PROVIDER_TO_INTEGRATION: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
  deepseek: "deepseek",
  cohere: "cohere",
  "github-copilot": "github-copilot",
};

export function integrationNameForProvider(provider: string): string {
  return PROVIDER_TO_INTEGRATION[provider] ?? provider;
}
