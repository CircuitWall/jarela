import type { TriggerHandler } from "./types";
import { getOrCreateGlobal } from "@/lib/utils/global-state";

// Module-level registry. getOrCreateGlobal so HMR / repeated imports in
// dev don't lose registrations across module re-evaluations.
interface RegistryState {
  handlers: Map<string, TriggerHandler>;
}
const state = getOrCreateGlobal<RegistryState>("__jarela_trigger_registry", () => ({
  handlers: new Map(),
}));

export function registerTriggerHandler(handler: TriggerHandler): void {
  state.handlers.set(handler.kind, handler);
}

export function getTriggerHandler(kind: string): TriggerHandler | undefined {
  return state.handlers.get(kind);
}

export function listTriggerHandlers(): TriggerHandler[] {
  return Array.from(state.handlers.values());
}

// Test helper. Not exposed in the public surface — only the test file
// reaches in to reset.
export function __resetTriggerRegistry(): void {
  state.handlers.clear();
}
