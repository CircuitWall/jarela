"use client";
import { Cloud, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { DocumentSource, DocumentSourceKind } from "@/api/types";
import { summarizeRemote } from "./helpers";

interface Props {
  sources: DocumentSource[];
  loading: boolean;
  busy: Record<string, boolean>;
  onReindex: (id: string) => void;
  onRemove: (id: string, summary: string, kind: DocumentSourceKind) => void;
  onToggle: (s: DocumentSource) => void;
}

export function SourceList({ sources, loading, busy, onReindex, onRemove, onToggle }: Props) {
  return (
    <section className="space-y-2">
      <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Indexed sources</label>
      {loading && sources.length === 0 && (
        <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
      )}
      {!loading && sources.length === 0 && (
        <p className="text-fg-faint text-xs italic">
          No sources yet. Add one above to start indexing.
        </p>
      )}
      {sources.map((s) => (
        <SourceRow
          key={s.id}
          source={s}
          busy={!!busy[s.id]}
          onReindex={onReindex}
          onRemove={onRemove}
          onToggle={onToggle}
        />
      ))}
    </section>
  );
}

interface RowProps {
  source: DocumentSource;
  busy: boolean;
  onReindex: (id: string) => void;
  onRemove: (id: string, summary: string, kind: DocumentSourceKind) => void;
  onToggle: (s: DocumentSource) => void;
}

function SourceRow({ source: s, busy, onReindex, onRemove, onToggle }: RowProps) {
  const summary = s.kind === "local_folder" ? s.path : summarizeRemote(s);
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        {s.kind === "local_folder"
          ? <FolderOpen size={13} className="text-fg-subtle shrink-0" />
          : <Cloud size={13} className="text-fg-subtle shrink-0" />}
        <span className="font-mono text-xs text-fg break-all flex-1">
          {s.label ? <strong>{s.label}</strong> : null}
          {s.label ? <span className="text-fg-faint"> — </span> : null}
          {summary}
        </span>
        <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={() => onToggle(s)}
          />
          enabled
        </label>
        <button
          onClick={() => onReindex(s.id)}
          disabled={busy}
          title={busy ? "Processing…" : "Re-scan now"}
          className="p-1 text-fg-subtle hover:text-fg disabled:opacity-40"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        </button>
        <button
          onClick={() => onRemove(s.id, summary, s.kind)}
          disabled={busy}
          title={busy ? "Processing…" : "Remove source"}
          className="p-1 text-fg-faint hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin text-red-600 dark:text-red-400" /> : <Trash2 size={13} />}
        </button>
      </div>
      <div className="text-[11px] text-fg-faint flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{s.stats.document_count} files</span>
        <span>{s.stats.chunk_count} chunks</span>
        <span>{s.stats.embedded_chunk_count} embedded</span>
        {s.last_scan_at && <span>last scan: {new Date(s.last_scan_at).toLocaleString()}</span>}
      </div>
      {!s.last_error && s.stats.chunk_count > 0 && s.stats.embedded_chunk_count === 0 && (
        <div className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          Warning: this source has chunks but zero embeddings. Semantic recall is degraded; check default model/provider embedding support.
        </div>
      )}
      {s.last_error && (
        <div className="text-[11px] text-red-600 dark:text-red-400 break-words">
          Last error: {s.last_error}
        </div>
      )}
    </div>
  );
}
