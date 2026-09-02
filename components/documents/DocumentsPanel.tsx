"use client";
import { AlertCircle, FolderSearch, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { AddSourceForm } from "./AddSourceForm";
import { EmbeddingModelSection } from "./EmbeddingModelSection";
import { SearchProbe } from "./SearchProbe";
import { SourceList } from "./SourceList";
import { useDocumentsPanel } from "./useDocumentsPanel";

export function DocumentsPanel() {
  const { dispatch } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const panel = useDocumentsPanel();
  const [refreshing, setRefreshing] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <FolderSearch size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Documents</h2>
        <button
          onClick={async () => {
            if (refreshing || panel.loading) return;
            setRefreshing(true);
            try {
              await panel.load();
            } finally {
              setRefreshing(false);
            }
          }}
          disabled={refreshing || panel.loading}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
          title="Refresh source list"
        >
          <RefreshCw size={13} className={refreshing || panel.loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-5">
        <p className="text-xs text-fg-faint leading-relaxed">
          Sources listed here are indexed in the background. Text files in folders are chunked, embedded, and
          made available to agents via the <code className="font-mono text-fg-muted">documents_search</code> tool.
          Remote sources reuse credentials configured in <em>Credentials</em>:
          {" "}Jira/Confluence under <em>Atlassian</em>, GitHub PRs/repos under <em>GitHub</em>, and mail under <em>Gmail</em>/<em>Outlook</em>.
          Embedding uses your default model provider; without one, search falls back to substring match.
        </p>

        <EmbeddingModelSection
          models={panel.models}
          embeddingModel={panel.embeddingModel}
          savingEmbeddingModel={panel.savingEmbeddingModel}
          embeddingProbe={panel.embeddingProbe}
          readiness={panel.readiness}
          hasWorkingEmbeddingModel={panel.hasWorkingEmbeddingModel}
          onSave={(v) => { void panel.saveEmbeddingModel(v); }}
          onOpenModels={() => dispatch({ type: "SET_TAB", tab: "models" })}
        />

        <AddSourceForm
          disabled={panel.loading}
          onSubmit={panel.addSource}
        />

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

        <SearchProbe onSearch={panel.search} />
      </div>
    </div>
  );
}
