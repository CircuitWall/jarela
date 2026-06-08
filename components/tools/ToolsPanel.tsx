"use client";
import { useAppContext } from "@/contexts/AppContext";
import { ExtensionsPanel } from "@/components/extensions/ExtensionsPanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { BuiltinToolsPanel } from "./BuiltinToolsPanel";

// "Tools" is about *capability presence* — which categories of tools
// the agent may use:
//   - "Built-in"   — enable / disable categories of tools that ship with
//                    Jarela (filters the agent permission editor + blocks
//                    invocation in lib/tools/index.ts).
//   - "Extensions" — the Jarela browser extension.
//   - "MCP"        — external Model Context Protocol servers (add /
//                    enable / disable). Credentials still flow through
//                    Connections; this surface owns the server roster.

type Sub = "builtin" | "extensions" | "mcp";

const SUB_TITLES: Record<Sub, string> = {
  builtin: "Built-in",
  extensions: "Browser extension",
  mcp: "MCP servers",
};

export function ToolsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.tools;
  const active: Sub =
    raw === "extensions" ? "extensions" : raw === "mcp" ? "mcp" : "builtin";

  const setSub = (s: Sub) => dispatch({ type: "SET_SELECTION", tab: "tools", itemId: s });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Tools sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2"
      >
        {("builtin extensions mcp".split(" ") as Sub[]).map((s) => {
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
        {active === "builtin" && <BuiltinToolsPanel />}
        {active === "extensions" && <ExtensionsPanel />}
        {active === "mcp" && <MCPPanel />}
      </div>
    </div>
  );
}
