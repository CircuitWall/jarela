"use client";

import { Package } from "lucide-react";
import { BuiltinToolsPanel } from "./BuiltinToolsPanel";
import { LangChainPackagesPanel } from "./LangChainPackagesPanel";
import { DefaultPackagesSection, DropInToolsSection } from "./PackageSections";

// Single home for everything that turns into a LangChain tool: bundled
// defaults, hot-loaded npm manifests, drop-in `.cjs` files, and the
// built-in tool catalogue. Sub-tabs above this panel still segregate
// MCP / Documents / Memory / Bridges so each has its own focused UI;
// this surface owns the pure tool-package experience.
export function PackagesPanel() {
  return (
    <div className="p-4 space-y-8">
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

      <DefaultPackagesSection />
      <div className="border-t border-border" />
      <LangChainPackagesPanel />
      <div className="border-t border-border" />
      <DropInToolsSection />
      <div className="border-t border-border" />
      <BuiltinToolsPanel />
    </div>
  );
}
