"use client";
import { Globe, Loader2, RefreshCw, Settings2, Terminal, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/api/client";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { NetworkSection } from "./NetworkSection";
import { AllowedSitesSection } from "./AllowedSitesSection";
import { EnvAliasEditor } from "./EnvAliasEditor";
import { NetworkEnvEditor } from "./NetworkEnvEditor";
import { errorMessage } from "@/lib/utils/error";

// "Network & environment" hosts everything that's NOT a credential: HTTP
// proxy, allowed sites, env-var aliases, and the env-sync button that
// pulls credential env vars (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) from
// the user's shell rc / Windows User env into the unified credentials
// store. Per-integration auth (keys + OAuth) lives in the sibling
// Credentials sub-tab.

export function NetworkPanel() {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [aliasEditorOpen, setAliasEditorOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("credentials", "network", containerRef);

  async function syncFromEnv() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.envSync.apply();
      const sourceLabel = r.discovered.source === "shell-rc"
        ? `your ${r.discovered.shell ?? "shell"} rc`
        : r.discovered.source === "windows-registry"
          ? "your Windows User env"
          : "the process env";
      if (r.applied_count > 0) {
        setSyncMsg(`Synced ${r.applied_count} field(s) from ${sourceLabel}.`);
      } else {
        const userSkipped = r.candidates.filter((c) => c.action === "skipped-user").length;
        const equal = r.candidates.filter((c) => c.action === "skipped-equal").length;
        const absent = r.candidates.filter((c) => c.action === "absent").length;
        if (userSkipped > 0) {
          setSyncMsg(`Nothing to write — ${userSkipped} field(s) were edited here and won't be overwritten.`);
        } else if (equal > 0 && absent === r.candidates.length - equal) {
          setSyncMsg(`Already up to date with ${sourceLabel}.`);
        } else {
          setSyncMsg(`No matching env vars set in ${sourceLabel}.`);
        }
      }
      // Notify the Credentials list so it re-loads any newly-synced rows.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
      }
    } catch (e) {
      setSyncMsg(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Globe size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Network &amp; environment</h2>
        <button
          onClick={() => setAliasEditorOpen((v) => !v)}
          title="Add additional env-var name aliases that env-sync should look for, per integration field."
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:bg-surface-3"
        >
          <Settings2 size={11} />
          Aliases
        </button>
        <button
          onClick={syncFromEnv}
          disabled={syncing}
          title="Pull standard credential env vars (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) from your shell rc / Windows User env into the Credentials list. Fields you've edited there are never overwritten."
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-50"
        >
          {syncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Sync from environment
        </button>
      </div>

      <div ref={containerRef} className="panel-scrollbar flex-1 overflow-y-auto px-4 py-3">
        {syncMsg && (
          <div className="mb-3 px-3 py-2 rounded border border-border bg-surface-2 text-[11px] text-fg-muted flex items-start gap-2">
            <Terminal size={12} className="mt-0.5 text-fg-subtle shrink-0" />
            <span className="flex-1">{syncMsg}</span>
            <button onClick={() => setSyncMsg(null)} className="text-fg-faint hover:text-fg">
              <XCircle size={12} />
            </button>
          </div>
        )}
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
