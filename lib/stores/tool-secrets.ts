// Encrypted-at-rest secrets for external tools (ADR-0023).
//
// External tools declare secret "slots" in their module.exports:
//   secrets: [{ key: "api_key", label: "OpenWeather API key", required: true }]
//
// Values are persisted in the `tool-secrets` namespace of the memory store
// (which is flagged sensitive in lib/crypto/sensitive.ts, so envelope
// encryption applies — same primitive as the integrations store).
//
// Keys are stored as `<toolName>:<slotKey>`. Tool names and slot keys are
// validated to a conservative character set so they can't collide with the
// namespace delimiter or smuggle SQL/JSON metacharacters.
//
// Note on isolation: external tools run in-process with full Node privileges
// (ADR-0013), so a malicious tool could read another tool's secrets by going
// around this API (e.g. directly opening the SQLite file). The per-tool
// scoping here is a *convention* surfaced through `ctx.getSecret`, not a
// sandbox boundary.

import { getMemory, putMemory, deleteMemory, listMemory } from "@/lib/stores/memory";

const NAMESPACE = "tool-secrets";
const NAME_RE = /^[a-z0-9_-]+$/i;

export interface ToolSecretSlot {
  key: string;
  label?: string;
  required?: boolean;
  description?: string;
}

function validName(s: string): boolean {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && NAME_RE.test(s);
}

function compoundKey(toolName: string, key: string): string {
  return `${toolName}:${key}`;
}

function parseStored(raw: string): string | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function getToolSecret(toolName: string, key: string): string | null {
  if (!validName(toolName) || !validName(key)) return null;
  const row = getMemory(NAMESPACE, compoundKey(toolName, key));
  if (!row) return null;
  return parseStored(row.value);
}

export function setToolSecret(toolName: string, key: string, value: string): void {
  if (!validName(toolName)) throw new Error(`invalid tool name: ${toolName}`);
  if (!validName(key)) throw new Error(`invalid secret key: ${key}`);
  if (typeof value !== "string") throw new Error("secret value must be a string");
  putMemory(NAMESPACE, compoundKey(toolName, key), value);
}

export function deleteToolSecret(toolName: string, key: string): boolean {
  if (!validName(toolName) || !validName(key)) return false;
  return deleteMemory(NAMESPACE, compoundKey(toolName, key));
}

// Returns which declared slots have a value persisted. Never returns the
// plaintext — that only escapes via `ctx.getSecret` inside the tool's own
// run loop.
export function describeToolSecrets(
  toolName: string,
  slots: ToolSecretSlot[],
): Array<ToolSecretSlot & { is_set: boolean }> {
  if (!validName(toolName)) return slots.map((s) => ({ ...s, is_set: false }));
  return slots.map((s) => ({
    ...s,
    is_set: getToolSecret(toolName, s.key) !== null,
  }));
}
