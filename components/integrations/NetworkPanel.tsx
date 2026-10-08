"use client";
import { Globe, Settings2 } from "lucide-react";
import { PanelHeader } from "@/components/ui/PanelHeader";
import { EnvSyncButton, EnvSyncNotice, useEnvSync } from "./EnvSync";
import { useRef, useState } from "react";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { NetworkSection } from "./NetworkSection";
import { AllowedSitesSection } from "./AllowedSitesSection";
import { EnvAliasEditor } from "./EnvAliasEditor";
import { NetworkEnvEditor } from "./NetworkEnvEditor";

// "Network & environment" hosts everything that's NOT a credential: HTTP
// proxy, allowed sites, env-var aliases, and the env-sync button that
// pulls credential env vars (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) from
// the user's shell rc / Windows User env into the unified credentials
// store. Per-integration auth (keys + OAuth) lives in the sibling
// Credentials sub-tab.

export function NetworkPanel() {
  const envSync = useEnvSync();
  const [aliasEditorOpen, setAliasEditorOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("credentials", "network", containerRef);

  return (
    <div className="flex flex-col h-full">
      <PanelHeader icon={<Globe size={14} />} title="Network &amp; environment">
        <button
          onClick={() => setAliasEditorOpen((v) => !v)}
          title="Add additional env-var name aliases that env-sync should look for, per integration field."
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:bg-surface-3"
        >
          <Settings2 size={11} />
          Aliases
        </button>
        <EnvSyncButton env={envSync} />
      </PanelHeader>

      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-3">
        <EnvSyncNotice env={envSync} />
        {aliasEditorOpen && (
          <EnvAliasEditor
            onClose={() => setAliasEditorOpen(false)}
            onSaved={() => { /* re-sync happens on next click of Sync button; nothing to refresh here */ }}
          />
        )}
        <NetworkSection />
        <AllowedSitesSection />
        <NetworkEnvEditor />
      </div>
    </div>
  );
}
