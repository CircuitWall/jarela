// Sensitive namespaces in `memory_store` whose `value` column holds
// secret material that must be encrypted at rest (ADR-0005).
//
// Centralised here so stores and the migration agree on the same list.

export const SENSITIVE_MEMORY_NAMESPACES: ReadonlySet<string> = new Set([
  "integrations",         // Atlassian / Gmail OAuth / Gemini keys
  "github-copilot-auth",  // GitHub Copilot device-flow OAuth token
]);

export function isSensitiveMemoryNamespace(ns: string): boolean {
  return SENSITIVE_MEMORY_NAMESPACES.has(ns);
}
