"use client";
import { useAppContext } from "@/contexts/AppContext";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { ExtensionsPanel } from "@/components/extensions/ExtensionsPanel";
import { BuiltinToolsPanel } from "./BuiltinToolsPanel";

// "Tools" is a top-level menu entry that bundles the capability surfaces
// behind a single nav label:
//   - "Built-in"   — enable / disable categories of tools that ship with
//                    Jarela (filters the agent permission editor + blocks
//                    invocation in lib/tools/index.ts).
//   - "MCP"        — connected MCP servers.
//   - "Extensions" — the Jarela browser extension.
//
// Credentials for any of these live under the Credentials/Connections tab,
// not here. This split keeps "what can the agent do" separate from "what
// auth does that capability need".
//
// The active sub-tab is persisted via the existing per-tab selectedItem
// reducer (state.selectedItem.tools), so deep-linking via the URL hash
// "just works" without bespoke routing.

type Sub = "builtin" | "mcp" | "extensions";

const SUB_TITLES: Record<Sub, string> = {
  builtin: "Built-in",
  mcp: "MCP servers",
  extensions: "Browser extension",
};

export function ToolsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.tools;
  const active: Sub =
    raw === "extensions" ? "extensions" : raw === "builtin" ? "builtin" : "mcp";

  const setSub = (s: Sub) => dispatch({ type: "SET_SELECTION", tab: "tools", itemId: s });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Tools sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2"
      >
        {(["builtin", "mcp", "extensions"] as Sub[]).map((s) => {
          const selected = s === active;
          return (
            <button
              key={s}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setSub(s)}
              className={
                "px-3 py-1.5 text-sm rounded-t-md border-b-2 -mb-px transition-colors " +
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
        {active === "builtin" ? (
          <BuiltinToolsPanel />
        ) : active === "mcp" ? (
          <MCPPanel />
        ) : (
          <ExtensionsPanel />
        )}
      </div>
    </div>
  );
}
