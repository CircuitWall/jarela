"use client";

import { Package } from "lucide-react";
import { PanelHeader } from "@/components/ui/PanelHeader";
import { SettingsCard, SettingsGroup } from "@/components/ui/SettingsCard";
import { InstallPanel } from "./InstallPanel";
import { ToolCatalog } from "./ToolCatalog";
import { UnifiedPackageList } from "./UnifiedPackageList";
import { WebSearchConfigCard } from "./WebSearchConfigCard";
import { InternalToolConfigCard } from "./InternalToolConfigCard";

// Single home for everything that turns into a LangChain tool.
//
// Layout (top → bottom): install action, the grouped package list, then
// runtime settings and the per-tool catalog as one-open-at-a-time drawers so
// the page stays short until you ask for the detail.
export function PackagesPanel() {
  return (
    <div>
      <PanelHeader icon={<Package size={14} />} title="Packages" />
      <div className="p-4 space-y-4">
        <p className="text-xs text-fg-faint">
          Built-in tools ship with Jarela; everything else is added at runtime and can be
          enabled, disabled, or removed. Drop-in tools show their credentials inline.
        </p>
        <InstallPanel />
        <UnifiedPackageList />
        <SettingsGroup>
          <InternalToolConfigCard />
          <WebSearchConfigCard />
          <SettingsCard id="catalog" title="Tool catalog">
            <ToolCatalog />
          </SettingsCard>
        </SettingsGroup>
      </div>
    </div>
  );
}
