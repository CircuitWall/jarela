import type { ModelProvider } from "./types";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { githubCopilotProvider } from "./github-copilot";
import { visaProvider } from "./visa";
import { deepseekProvider } from "./deepseek";
import { langchainProvider } from "./langchain";

const PROVIDERS: Record<string, ModelProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  "github-copilot": githubCopilotProvider,
  visa: visaProvider,
  deepseek: deepseekProvider,
  langchain: langchainProvider,
};

export function getProvider(name: string): ModelProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

export { type ModelProvider };
export type { ProviderMessage, ProviderParams, ProviderStreamResult } from "./types";
