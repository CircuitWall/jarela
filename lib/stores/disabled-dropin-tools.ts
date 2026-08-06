// Enable/disable state for drop-in .cjs tools loaded from JARELA_TOOLS_DIR.
//
// Reuses the `disabled_packages` table (same semantics: missing row = enabled).
// IDs are prefixed with "dropin:" to avoid collisions with LangChain package IDs.

import {
  isPackageDisabled,
  setPackageDisabled,
} from "@/lib/stores/disabled-packages";

const PREFIX = "dropin:";

export function isDropinDisabled(toolName: string): boolean {
  return isPackageDisabled(`${PREFIX}${toolName}`);
}

export function setDropinDisabled(toolName: string, disabled: boolean): void {
  setPackageDisabled(`${PREFIX}${toolName}`, disabled);
}
