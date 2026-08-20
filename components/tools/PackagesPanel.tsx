"use client";

import { Package } from "lucide-react";
import { InstallPanel } from "./InstallPanel";
import { ToolCatalog } from "./ToolCatalog";
import { UnifiedPackageList } from "./UnifiedPackageList";
import { WebSearchConfigCard } from "./WebSearchConfigCard";

// Single home for everything that turns into a LangChain tool.
//
// Layout (top → bottom):
//   1. "Install package" — collapsible action: npm install + pending
//      approvals + manual manifest editor.
//   2. UnifiedPackageList — every package surface in one list:
//      built-in categories, bundled defaults, npm-installed manifests,
//      drop-in `.cjs` files. Source filter + search.
//   3. ToolCatalog — per-tool drill-down with rank stats and filters.
//
// Sub-tabs above this panel still segregate MCP / Documents / Memory /
// Bridges so each gets its own focused UI; this surface owns the
// LangChain-tool-package experience end to end.
export function PackagesPanel() {
  return (
    <div className="p-4 space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Package size={14} className="text-fg-subtle" />
          <h2 className="text-sm font-semibold text-fg">Packages</h2>
        </div>
        <p className="text-xs text-fg-faint">
          One place to manage every LangChain-style tool surface. Built-in
          tools ship with Jarela; everything below them is added at runtime
          and can be enabled, disabled, or removed.
        </p>
      </header>

      <InstallPanel />
      <WebSearchConfigCard />
      <UnifiedPackageList />
      <div className="border-t border-border pt-4" />
      <ToolCatalog />
    </div>
  );
}
