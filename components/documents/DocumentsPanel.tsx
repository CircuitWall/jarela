"use client";
import { AlertCircle, FolderSearch, RefreshCw } from "lucide-react";
import { HeaderAction, PanelHeader } from "@/components/ui/PanelHeader";
import { useRef, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { AddSourceForm } from "./AddSourceForm";
import { SearchProbe } from "./SearchProbe";
import { SourceList } from "./SourceList";
import { useDocumentsPanel } from "./useDocumentsPanel";

export function DocumentsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { dispatch } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const panel = useDocumentsPanel();
  const [refreshing, setRefreshing] = useState(false);

  return (
    <div className={embedded ? "" : "flex flex-col h-full"}>
      {!embedded && (
        <PanelHeader icon={<FolderSearch size={14} />} title="Documents">
          <HeaderAction
            icon={<RefreshCw size={13} className={refreshing || panel.loading ? "animate-spin" : ""} />}
            label="Refresh"
            title="Refresh source list"
            disabled={refreshing || panel.loading}
            onClick={async () => {
              setRefreshing(true);
              try {
                await panel.load();
              } finally {
                setRefreshing(false);
              }
            }}
          />
        </PanelHeader>
      )}

      <div ref={containerRef} className={embedded ? "px-4 py-3 space-y-5" : "flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-5"}>
        <p className="text-xs text-fg-faint leading-relaxed">
          Sources listed here are indexed in the background. Text files in folders are chunked, embedded, and
          made available to agents via the <code className="font-mono text-fg-muted">documents_search</code> tool.
          Remote sources reuse credentials configured in <em>Credentials</em>:
          {" "}Jira/Confluence under <em>Atlassian</em>, GitHub PRs/repos under <em>GitHub</em>, and mail under <em>Gmail</em>/<em>Outlook</em>.
          Embedding uses the model chosen in{" "}
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_SELECTION", tab: "settings", itemId: "models" })}
            className="text-accent hover:text-accent-hover"
          >
            Settings → Models
          </button>; without one, search falls back to substring match.
        </p>

        <AddSourceForm
          disabled={panel.loading}
          onSubmit={panel.addSource}
        />

        {embedded && (
          <button
            type="button"
            onClick={async () => {
              setRefreshing(true);
              try {
                await panel.load();
              } finally {
                setRefreshing(false);
              }
            }}
            disabled={refreshing || panel.loading}
            className="text-xs text-accent hover:text-accent-hover disabled:opacity-50"
          >
            Refresh sources
          </button>
        )}

        {panel.error && (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="break-words">{panel.error}</span>
          </div>
        )}

        <SourceList
          sources={panel.sources}
          loading={panel.loading}
          busy={panel.busy}
          onReindex={(id) => { void panel.reindex(id); }}
          onRemove={(id, summary, kind) => { void panel.removeSource(id, summary, kind); }}
          onToggle={(s) => { void panel.toggleSource(s); }}
        />

        {!embedded && <SearchProbe onSearch={panel.search} />}
      </div>
    </div>
  );
}
