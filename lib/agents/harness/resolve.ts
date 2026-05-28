import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { getDefaultHarnessId, getHarness } from "@/lib/stores/harnesses";
import { getBuiltinHarness } from "./presets";
import { DEFAULT_HARNESS_ID, HARNESS_SECTION_KEYS, type HarnessSectionKey } from "./types";

export type ResolvedHarnessSections = Record<HarnessSectionKey, string>;

/**
 * Resolve which harness applies to a given agent and return its section
 * bodies as a record. Disabled sections become empty strings (so the
 * caller's `.filter(Boolean)` in systemParts assembly drops them).
 *
 * Resolution order:
 *   1. agentCfg.harness_id (per-agent override)
 *   2. app-settings default_harness_id (global default)
 *   3. builtin:default
 *
 * Stale ids (custom harness deleted out from under an agent) fall back to
 * builtin:default rather than erroring — matches how missing model configs
 * behave in this codebase.
 */
export function resolveHarness(
  agentCfg: Pick<AgentConfigRow, "harness_id">,
): ResolvedHarnessSections {
  const id = agentCfg.harness_id || getDefaultHarnessId() || DEFAULT_HARNESS_ID;
  const harness =
    getHarness(id) ?? getBuiltinHarness(DEFAULT_HARNESS_ID) ?? null;
  const out = {} as ResolvedHarnessSections;
  for (const key of HARNESS_SECTION_KEYS) {
    const section = harness?.sections[key];
    out[key] = section?.enabled ? section.body : "";
  }
  return out;
}
