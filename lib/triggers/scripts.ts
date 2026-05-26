// ADR-0027. In-process script registry for ScriptFiring.
//
// Trust model: only built-ins are registered, in code, at module load
// time. There is NO mechanism to register a script from DB, user input,
// or shell-out — `script` on a ScriptFiring is just a key into this
// map. This keeps scripted triggers safe even though they bypass the
// LLM/thread machinery that gates prompt firings.

import { getOrCreateGlobal } from "@/lib/utils/global-state";

export interface ScriptResult {
  /** Short, single-line summary suitable for telemetry / logs. */
  preview: string;
}

export type ScriptFn = (args: Record<string, unknown>) => Promise<ScriptResult>;

interface ScriptRegistryState {
  scripts: Map<string, ScriptFn>;
}

const state = getOrCreateGlobal<ScriptRegistryState>(
  "__jarela_trigger_scripts",
  () => ({ scripts: new Map() }),
);

export function registerScript(name: string, fn: ScriptFn): void {
  // Idempotent re-registration is fine — HMR and repeated module imports
  // in dev re-execute the registration calls. We just overwrite with the
  // latest function, matching the trigger handler registry's behaviour.
  state.scripts.set(name, fn);
}

export function getScript(name: string): ScriptFn | undefined {
  return state.scripts.get(name);
}

export function listScripts(): string[] {
  return Array.from(state.scripts.keys()).sort();
}

/** Test-only helper. */
export function __resetScriptRegistry(): void {
  state.scripts.clear();
}
