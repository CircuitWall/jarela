"use client";
import { useAppContext } from "@/contexts/AppContext";
import { ExtensionsPanel } from "@/components/extensions/ExtensionsPanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { DocumentsPanel } from "@/components/documents/DocumentsPanel";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { BridgesPanel } from "@/components/bridges/BridgesPanel";
import { BuiltinToolsPanel } from "./BuiltinToolsPanel";
import { LangChainPackagesPanel } from "./LangChainPackagesPanel";

// "Tools" is about *capability presence* — every surface that determines
// what an agent can sense or act on lives here:
//   - "Built-in"   — categories of tools that ship with Jarela.
//   - "Packages"   — vanilla LangChain tool packages hot-loaded from npm.
//   - "Documents"  — indexed knowledge sources the agent can search.
//   - "Memory"     — long-lived facts persisted across conversations.
//   - "MCP"        — external Model Context Protocol servers.
//   - "Extensions" — the Jarela browser extension surface.
//   - "Bridges"    — mobile / messaging bridge pairings.
// Credentials still flow through the Credentials tab; this surface owns
// the capability roster.

type Sub =
  | "builtin"
  | "packages"
  | "documents"
  | "memory"
  | "mcp"
  | "extensions"
  | "bridges";

const SUBS: Sub[] = [
  "builtin",
  "packages",
  "documents",
  "memory",
  "mcp",
  "extensions",
  "bridges",
];

const SUB_TITLES: Record<Sub, string> = {
  builtin: "Built-in",
  packages: "LangChain packages",
  documents: "Documents",
  memory: "Memory",
  mcp: "MCP servers",
  extensions: "Browser extension",
  bridges: "Bridges",
};

export function ToolsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.tools;
  const active: Sub = (SUBS as string[]).includes(raw ?? "")
    ? (raw as Sub)
    : "builtin";

  const setSub = (s: Sub) => dispatch({ type: "SET_SELECTION", tab: "tools", itemId: s });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Tools sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2 overflow-x-auto"
      >
        {SUBS.map((s) => {
          const selected = s === active;
          return (
            <button
              key={s}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setSub(s)}
              className={
                "px-3 py-1.5 text-sm rounded-t-md border-b-2 -mb-px transition-colors whitespace-nowrap " +
                (selected
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--bg-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {SUB_TITLES[s]}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {active === "builtin" && <BuiltinToolsPanel />}
        {active === "packages" && <LangChainPackagesPanel />}
        {active === "documents" && <DocumentsPanel />}
        {active === "memory" && <MemoryPanel />}
        {active === "mcp" && <MCPPanel />}
        {active === "extensions" && <ExtensionsPanel />}
        {active === "bridges" && <BridgesPanel />}
      </div>
    </div>
  );
}
