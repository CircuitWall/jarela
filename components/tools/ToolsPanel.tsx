"use client";
import { useAppContext } from "@/contexts/AppContext";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { DocumentsPanel } from "@/components/documents/DocumentsPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { BridgesPanel } from "@/components/bridges/BridgesPanel";
import { PackagesPanel } from "./PackagesPanel";
import { SubTabBar, type SubTabItem } from "@/components/ui/SubTabBar";

// "Tools" segregates capability surfaces by ownership model:
//   - "Packages"  — built-in tools, default LangChain packages, hot-loaded
//                   manifests, and drop-in `.cjs` files. One home for
//                   everything that turns into a LangChain tool.
//   - "Documents" — indexed knowledge sources the agent can search.
//   - "Memory"    — long-lived facts persisted across conversations.
//   - "MCP"       — external Model Context Protocol servers.
//   - "Bridges"   — mobile / messaging bridge pairings.
// Credentials still flow through Settings → Credentials.

type Sub =
  | "packages"
  | "documents"
  | "memory"
  | "mcp"
  | "bridges";

const SUBS: Sub[] = ["packages", "documents", "memory", "mcp", "bridges"];

const SUB_TITLES: Record<Sub, string> = {
  packages: "Packages",
  documents: "Documents",
  memory: "Memory",
  mcp: "MCP servers",
  bridges: "Bridges",
};

// Old sub-tab ids redirect to their new home so existing deep links
// keep resolving.
const LEGACY_SUBS: Record<string, Sub> = {
  builtin: "packages",
  extensions: "packages",
};

export function ToolsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.tools;
  const mapped = raw && LEGACY_SUBS[raw] ? LEGACY_SUBS[raw] : raw;
  const active: Sub = (SUBS as string[]).includes(mapped ?? "")
    ? (mapped as Sub)
    : "packages";

  const setSub = (s: Sub) => dispatch({ type: "SET_SELECTION", tab: "tools", itemId: s });

  const tabItems: SubTabItem<Sub>[] = SUBS.map((s) => ({ id: s, label: SUB_TITLES[s] }));

  return (
    <div className="flex flex-col h-full min-h-0">
      <SubTabBar
        ariaLabel="Tools sub-section"
        tabs={tabItems}
        active={active}
        onChange={setSub}
      />
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {active === "packages" && <PackagesPanel />}
        {active === "documents" && <DocumentsPanel />}
        {active === "memory" && <MemoryPanel />}
        {active === "mcp" && <MCPPanel />}
        {active === "bridges" && <BridgesPanel />}
      </div>
    </div>
  );
}

