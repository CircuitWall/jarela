"use client";
import { useEffect, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { api } from "@/api/client";

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

type Counts = { connected: number; total: number };

export function ConnectionsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.connections;
  const active: Sub = raw === "mcp" ? "mcp" : "builtin";

  // Lightweight per-sub counts so the user sees at a glance which surface
  // still has work to do. The child panels do their own authoritative
  // fetches; this just powers the header badges.
  const [counts, setCounts] = useState<Record<Sub, Counts | null>>({ builtin: null, mcp: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ints, mcps] = await Promise.all([
          api.integrations.list(),
          api.mcp.list(),
        ]);
        if (cancelled) return;
        const builtin: Counts = {
          connected: ints.statuses.filter((s) => s.configured).length,
          total: ints.definitions.length,
        };
        const mcp: Counts = {
          connected: mcps.filter((m) => m.enabled !== false).length,
          total: mcps.length,
        };
        setCounts({ builtin, mcp });
      } catch {
        /* counts are best-effort; child panels surface real errors */
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
          const c = counts[s];
          return (
            <button
              key={s}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setSub(s)}
              className={
                "px-3 py-1.5 text-sm rounded-t-md border-b-2 -mb-px transition-colors inline-flex items-center gap-2 " +
                (selected
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--bg-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              <span>{SUB_TITLES[s]}</span>
              {c && (
                <span
                  className={
                    "text-[10px] px-1.5 py-0.5 rounded-full border " +
                    (c.connected > 0
                      ? "border-accent/40 bg-accent/10 text-[var(--text-primary)]"
                      : "border-[var(--border)] bg-transparent text-[var(--text-secondary)]")
                  }
                  aria-label={`${c.connected} of ${c.total} connected`}
                >
                  {c.connected}/{c.total}
                </span>
              )}
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
