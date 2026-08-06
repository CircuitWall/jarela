// Non-secret configuration values for external tools.
//
// Unlike tool-secrets (ADR-0023), config values are NOT encrypted at rest —
// they hold non-sensitive settings like base URLs, timeouts, or feature flags.
// The actual value is returned directly (not masked) since it is not secret.
//
// Keys follow the same compound format as tool-secrets: `<toolName>:<slotKey>`.

import { getMemory, putMemory, deleteMemory } from "@/lib/stores/memory";

const NAMESPACE = "tool-config";
const NAME_RE = /^[a-z0-9_-]+$/i;

export interface ToolConfigSlot {
  key: string;
  label?: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string;
  description?: string;
}

function validName(s: string): boolean {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && NAME_RE.test(s);
}

function compoundKey(toolName: string, key: string): string {
  return `${toolName}:${key}`;
}

export function getToolConfig(toolName: string, key: string): string | null {
  if (!validName(toolName) || !validName(key)) return null;
  const row = getMemory(NAMESPACE, compoundKey(toolName, key));
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function setToolConfig(toolName: string, key: string, value: string): void {
  if (!validName(toolName)) throw new Error(`invalid tool name: ${toolName}`);
  if (!validName(key)) throw new Error(`invalid config key: ${key}`);
  if (typeof value !== "string") throw new Error("config value must be a string");
  putMemory(NAMESPACE, compoundKey(toolName, key), value);
}

export function deleteToolConfig(toolName: string, key: string): boolean {
  if (!validName(toolName) || !validName(key)) return false;
  return deleteMemory(NAMESPACE, compoundKey(toolName, key));
}

// Returns each declared slot with its current persisted value (or null).
// Unlike tool-secrets, the actual value is included — config is not secret.
export function describeToolConfig(
  toolName: string,
  slots: ToolConfigSlot[],
): Array<ToolConfigSlot & { value: string | null }> {
  if (!validName(toolName)) return slots.map((s) => ({ ...s, value: null }));
  return slots.map((s) => ({
    ...s,
    value: getToolConfig(toolName, s.key),
  }));
}
