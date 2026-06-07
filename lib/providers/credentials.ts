// Shared API-key resolution for built-in providers. Looks up the key in
// fallback order: explicit per-call params → the typed integration credential
// row written by the Credentials panel → process env. This keeps the
// "where does my key come from" rule consistent across every provider, and
// means saving an OpenAI / DeepSeek / Gemini / Cohere / GitHub-Copilot key in
// the picker actually has an effect at runtime.

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { integrationNameForProvider } from "./provider-integration-map";
import type { ProviderParams } from "./types";

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  cohere: "COHERE_API_KEY",
  "github-copilot": "GITHUB_COPILOT_TOKEN",
};

export function resolveProviderApiKey(provider: string, params: ProviderParams): string | undefined {
  if (typeof params.api_key === "string" && params.api_key) return params.api_key;
  const integrationName = integrationNameForProvider(provider);
  const fromIntegration = getIntegrationRaw(integrationName)?.api_key;
  if (typeof fromIntegration === "string" && fromIntegration) return fromIntegration;
  const envVar = PROVIDER_ENV[provider];
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (typeof fromEnv === "string" && fromEnv) return fromEnv;
  }
  return undefined;
}
