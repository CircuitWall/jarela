import type { ModelProvider } from "./types";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { githubCopilotProvider } from "./github-copilot";
import { visaProvider } from "./custom-provider";
import { deepseekProvider } from "./deepseek";
import { langchainProvider } from "./langchain";

const PROVIDERS: Record<string, ModelProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  "github-copilot": githubCopilotProvider,
  custom-provider: visaProvider,
  deepseek: deepseekProvider,
  langchain: langchainProvider,
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
