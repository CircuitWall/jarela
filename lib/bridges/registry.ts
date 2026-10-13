import type { BridgeModule } from "./types";
import type { BridgeModuleInfo } from "@/api/types";
import { whatsappBridgeModule } from "./modules/whatsapp";

const BRIDGE_MODULES: readonly BridgeModule[] = [whatsappBridgeModule];
const MODULES_BY_KIND = new Map(BRIDGE_MODULES.map((module) => [module.kind, module]));

if (MODULES_BY_KIND.size !== BRIDGE_MODULES.length) {
  throw new Error("[bridges] duplicate bridge module kind");
}

export function getBridgeModule(kind: string): BridgeModule | undefined {
  return MODULES_BY_KIND.get(kind);
}

export function isBridgeKind(kind: string): boolean {
  return MODULES_BY_KIND.has(kind);
}

export function listBridgeModules(): BridgeModuleInfo[] {
  return BRIDGE_MODULES.map(({ createAdapter: _createAdapter, removeAuth: _removeAuth, ...info }) => info);
}