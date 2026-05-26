"use client";
import { useAppContext } from "@/contexts/AppContext";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";

// "Connections" is the single home for every auth surface — built-in
// integrations (Gmail, Atlassian, GitHub, …) AND MCP server credentials.
// Tools tab is purely about *capability presence* (what can the agent do);
// Connections is about *auth* (what accounts has it been given access to).
//
// The active sub-tab is persisted via state.selectedItem.connections so
// deep links (`#?tab=connections&item=mcp`) work without bespoke routing.

type Sub = "builtin" | "mcp";

const SUB_TITLES: Record<Sub, string> = {
  builtin: "Built-in integrations",
  mcp: "MCP servers",
};

export function ConnectionsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.connections;
  const active: Sub = raw === "mcp" ? "mcp" : "builtin";

  const setSub = (s: Sub) =>
    dispatch({ type: "SET_SELECTION", tab: "connections", itemId: s });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Connections sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2"
      >
        {(["builtin", "mcp"] as Sub[]).map((s) => {
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
        {active === "builtin" ? <IntegrationsPanel /> : <MCPPanel />}
      </div>
    </div>
  );
}
