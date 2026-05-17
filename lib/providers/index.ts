import type { ModelProvider } from "./types";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { githubCopilotProvider } from "./github-copilot";
import { deepseekProvider } from "./deepseek";
import { geminiProvider } from "./gemini";
import { langchainProvider } from "./langchain";
import { loadExternalProviders } from "./external";

const BUILTINS: Record<string, ModelProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  "github-copilot": githubCopilotProvider,
  deepseek: deepseekProvider,
  gemini: geminiProvider,
  langchain: langchainProvider,
};

const PROVIDERS: Record<string, ModelProvider> = {
  ...BUILTINS,
  ...loadExternalProviders(new Set(Object.keys(BUILTINS))),
};

export function listProviderNames(): string[] {
  return Object.keys(PROVIDERS).sort((a, b) => a.localeCompare(b));
}

export function getProvider(name: string): ModelProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

export { type ModelProvider };
export type { ProviderMessage, ProviderParams, ProviderStreamResult } from "./types";
