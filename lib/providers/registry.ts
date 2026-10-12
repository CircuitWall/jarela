import type { ModelProvider } from "./types";

const BUILTIN_PROVIDERS = new Map<string, ModelProvider>();

export function registerBuiltinProvider<T extends ModelProvider>(provider: T): T {
  const name = provider.name.trim();
  if (!name) throw new Error("[providers] built-in provider name cannot be empty");
  const existing = BUILTIN_PROVIDERS.get(name);
  if (existing) {
    if (existing === provider) return provider;
    throw new Error(`[providers] duplicate built-in provider registration: ${name}`);
  }
  BUILTIN_PROVIDERS.set(name, provider);
  return provider;
}

export function getBuiltinProviders(): Record<string, ModelProvider> {
  return Object.fromEntries(BUILTIN_PROVIDERS);
}

export function getBuiltinProviderNames(): ReadonlySet<string> {
  return new Set(BUILTIN_PROVIDERS.keys());
}