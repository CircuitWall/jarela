import { getConfig } from "@/lib/env/config";

const OPENAI_COMPAT_PROVIDER_TOOL_LIMIT = 128;

const OPENAI_COMPAT_PROVIDERS = new Set([
  "openai",
  "github-copilot",
  "deepseek",
]);

export function getEffectiveProviderToolLimit(providerName: string | null | undefined): number {
  const configured = getConfig().providerToolLimit;
  if (providerName && OPENAI_COMPAT_PROVIDERS.has(providerName)) {
    return Math.min(configured, OPENAI_COMPAT_PROVIDER_TOOL_LIMIT);
  }
  return configured;
}

