import "./builtins";
import type { ModelProvider } from "./types";
import { getBuiltinProviderNames, getBuiltinProviders } from "./registry";
import { loadExternalProviders } from "./external";
import { getConfig } from "@/lib/env/config";
import { parseRateLimitOverrides, ProviderRateLimiter, withProviderRateLimits } from "./rate-limit";
import { withRedaction } from "@/lib/redaction/mask-provider";

const limitedProviders = new WeakMap<ModelProvider, ModelProvider>();
const providerGlobals = globalThis as typeof globalThis & {
  __jarelaProviderRateLimiter?: ProviderRateLimiter;
};

// The mock provider is opt-in via env so production deployments never
// expose it as a selectable backend. Tests / offline dev set the flag.
function isMockEnabled(): boolean {
  return getConfig().enableMockProvider;
}

export const BUILTIN_PROVIDER_NAMES = getBuiltinProviderNames();

// Recompute on every call so external providers dropped into ~/.jarela/providers/
// are picked up without a process restart. loadExternalProviders cache-busts
// require() per file, so edits are reflected immediately too.
function getProviders(): Record<string, ModelProvider> {
  const base = getBuiltinProviders();
  if (!isMockEnabled()) delete base.mock;
  return { ...base, ...loadExternalProviders(BUILTIN_PROVIDER_NAMES) };
}

export function listProviderNames(): string[] {
  return Object.keys(getProviders()).sort((a, b) => a.localeCompare(b));
}

// Every provider handed out here is rate-limited and redacted: outbound
// payloads are masked and responses rehydrated (ADR-0064), so no caller can
// reach a model with unmasked content.
export function getProvider(name: string): ModelProvider {
  const all = getProviders();
  const p = all[name];
  if (!p) throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(all).join(", ")}`);
  let limited = limitedProviders.get(p);
  if (!limited) {
    providerGlobals.__jarelaProviderRateLimiter ??= new ProviderRateLimiter(
      parseRateLimitOverrides(getConfig().providerRateLimits),
    );
    limited = withRedaction(withProviderRateLimits(p, providerGlobals.__jarelaProviderRateLimiter));
    limitedProviders.set(p, limited);
  }
  return limited;
}

export { type ModelProvider };
export type { ProviderMessage, ProviderParams, ProviderStreamResult } from "./types";
