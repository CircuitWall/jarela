import type { ModelProvider } from "./types";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { githubCopilotProvider } from "./github-copilot";
import { deepseekProvider } from "./deepseek";
import { geminiProvider } from "./gemini";
import { langchainProvider } from "./langchain";
import { mockProvider } from "./mock";
import { loadExternalProviders } from "./external";
import { getConfig } from "@/lib/env/config";

const BUILTINS: Record<string, ModelProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  "github-copilot": githubCopilotProvider,
  deepseek: deepseekProvider,
  gemini: geminiProvider,
  langchain: langchainProvider,
};

// The mock provider is opt-in via env so production deployments never
// expose it as a selectable backend. Tests / offline dev set the flag.
function isMockEnabled(): boolean {
  return getConfig().enableMockProvider;
}

export const BUILTIN_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(BUILTINS),
  "mock",
]);

// Recompute on every call so external providers dropped into ~/.jarela/providers/
// are picked up without a process restart. loadExternalProviders cache-busts
// require() per file, so edits are reflected immediately too.
function getProviders(): Record<string, ModelProvider> {
  const base: Record<string, ModelProvider> = { ...BUILTINS };
  if (isMockEnabled()) base.mock = mockProvider;
  return { ...base, ...loadExternalProviders(BUILTIN_PROVIDER_NAMES) };
}

export function listProviderNames(): string[] {
  return Object.keys(getProviders()).sort((a, b) => a.localeCompare(b));
}

export function getProvider(name: string): ModelProvider {
  const all = getProviders();
  const p = all[name];
  if (!p) throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(all).join(", ")}`);
  return p;
}

export { type ModelProvider };
export type { ProviderMessage, ProviderParams, ProviderStreamResult } from "./types";
