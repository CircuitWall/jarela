// Single source of truth for the memory contract every agent shares.
//
// The shape rules live in `record.ts`; this module names the contract, the
// canonical namespace and key convention, and the namespaces Jarela owns
// elsewhere. Tools, the agent prompt and the memory-organization skill must
// agree with these values — `contract.test.ts` fails when the skill text
// drifts from the schema.
import { SENSITIVE_MEMORY_NAMESPACES } from "@/lib/crypto/sensitive";
import { CURRENT_STRUCTURED_MEMORY_VERSION } from "./record";

/** Bump when the canonical namespace, key rule or required fields change. */
export const MEMORY_CONTRACT_VERSION = 1 as const;

/** Namespace for durable knowledge that should surface in future turns. */
export const MEMORY_FACTS_NAMESPACE = "facts";

/**
 * Canonical key rule for `facts`. Other namespaces hold legacy or subsystem
 * values whose keys are not ours to rewrite.
 */
export const MEMORY_KEY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;
export const MEMORY_KEY_RULE =
  "letters, digits, '.', '_', ':', or '-' only, starting with a letter or digit, with no spaces";

// Namespaces another subsystem owns: encrypted secrets, derived routing
// metadata, app and Security settings, app lifecycle state, compacted session
// recaps and raw chat transcripts. Maintenance must never read, merge or
// archive them.
export const MEMORY_MAINTENANCE_EXCLUDED_NAMESPACES: readonly string[] = [...new Set<string>([
  ...SENSITIVE_MEMORY_NAMESPACES,
  "agent-advertisements",
  "app-settings",
  "app-lifecycle",
  "sessions",
  "chat_archive",
])];

const EXCLUDED_NAMESPACE_SET = new Set<string>(MEMORY_MAINTENANCE_EXCLUDED_NAMESPACES);

export function isMaintainableMemoryNamespace(namespace: string): boolean {
  return !EXCLUDED_NAMESPACE_SET.has(namespace);
}

/** One-line contract statement shared by the prompt and the skill. */
export function memoryContractSummary(): string {
  return `Memory contract v${MEMORY_CONTRACT_VERSION} / record schema v${CURRENT_STRUCTURED_MEMORY_VERSION}: `
    + `durable knowledge goes to namespace '${MEMORY_FACTS_NAMESPACE}' as a structured record with a stable key (${MEMORY_KEY_RULE}).`;
}
