"use client";
import { useAppContext } from "@/contexts/AppContext";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { ExtensionsPanel } from "@/components/extensions/ExtensionsPanel";

// "Tools" is a top-level menu entry that bundles two pre-existing
// panels — MCP servers and Browser extensions — behind a single nav
// label. The grouping mirrors what users actually think of as "extending
// what the agent can do": connect external tool servers (MCP) or surface
// browser-side capabilities (the Jarela extension). Built-in tools have
// no configuration of their own and live in agent editors, so this
// panel intentionally has only two sub-tabs.
//
// The active sub-tab is persisted via the existing per-tab selectedItem
// reducer (state.selectedItem.tools), so deep-linking via the URL hash
// "just works" without bespoke routing.

type Sub = "mcp" | "extensions";

const SUB_TITLES: Record<Sub, string> = {
  mcp: "MCP servers",
  extensions: "Browser extension",
};

export function ToolsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.tools;
  const active: Sub = raw === "extensions" ? "extensions" : "mcp";

  const setSub = (s: Sub) => dispatch({ type: "SET_SELECTION", tab: "tools", itemId: s });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Tools sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2"
      >
        {(["mcp", "extensions"] as Sub[]).map((s) => {
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
        {active === "mcp" ? <MCPPanel /> : <ExtensionsPanel />}
      </div>
    </div>
  );
}
