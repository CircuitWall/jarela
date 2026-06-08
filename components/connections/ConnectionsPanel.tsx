"use client";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";

// Connections is the auth surface for built-in integrations (Gmail,
// Atlassian, GitHub, …). MCP servers used to live here as a sub-tab
// but moved back under Tools — the roster of MCP servers is closer to
// a capability decision than an auth decision.

export function ConnectionsPanel() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-auto">
        <IntegrationsPanel />
      </div>
    </div>
  );
}
