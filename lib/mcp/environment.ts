export interface McpEnvironmentEntry {
  name: string;
  value: string;
}

export function validateMcpEnvironment(entries: readonly McpEnvironmentEntry[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) return "Environment variable names are required.";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return `Invalid environment variable name: ${name}`;
    }
    const normalized = name.toUpperCase();
    if (seen.has(normalized)) return `Duplicate environment variable: ${name}`;
    seen.add(normalized);
  }
  return null;
}

export function mergeMcpEnvironment(
  spec: Record<string, unknown>,
  entries: readonly McpEnvironmentEntry[],
): Record<string, unknown> {
  const error = validateMcpEnvironment(entries);
  if (error) throw new Error(error);

  const next = { ...spec };
  if (entries.length === 0) {
    delete next.env;
  } else {
    next.env = Object.fromEntries(entries.map(({ name, value }) => [name.trim(), value]));
  }
  return next;
}