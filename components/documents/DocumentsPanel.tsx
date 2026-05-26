"use client";
import { AlertCircle, FolderOpen, FolderSearch, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { DocumentHit, DocumentSource } from "@/api/types";
import { FolderPickerDialog } from "./FolderPickerDialog";

export function DocumentsPanel() {
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addPath, setAddPath] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Per-source busy state for reindex spinners.
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Quick search panel.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentHit[]>([]);
  const [searching, setSearching] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSources(await api.documents.listSources());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function addSource() {
    const trimmedPath = addPath.trim();
    if (!trimmedPath) return;
    setAdding(true);
    setError(null);
    try {
      await api.documents.createSource({
        path: trimmedPath,
        label: addLabel.trim() || null,
      });
      setAddPath("");
      setAddLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function reindex(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await api.documents.reindex(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function removeSource(id: string, path: string) {
    if (!confirm(`Stop indexing ${path}? This deletes all chunks for this folder. Files on disk are untouched.`)) return;
    try {
      await api.documents.deleteSource(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleSource(s: DocumentSource) {
    try {
      await api.documents.updateSource(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) { setHits([]); return; }
    setSearching(true);
    try {
      const res = await api.documents.search(q, { limit: 8 });
      setHits(res.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <FolderSearch size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Documents</h2>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Refresh source list"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        <p className="text-xs text-fg-faint leading-relaxed">
          Folders listed here are scanned every ~10 minutes. Text files are chunked, embedded, and made available
          to agents via the <code className="font-mono text-fg-muted">documents_search</code> tool. Embedding uses
          your default model provider; without one, search falls back to substring match.
        </p>

        {/* Add new source */}
        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Add a folder</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex flex-1 min-w-0 gap-1">
              <input
                type="text"
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                placeholder="Pick or paste an absolute path"
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
              />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                title="Browse for a folder"
                className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-surface-3 border border-border text-xs text-fg hover:bg-surface-2 transition-colors"
              >
                <FolderOpen size={13} /> Browse
              </button>
            </div>
            <input
              type="text"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="Label (optional)"
              className="sm:w-40 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
            />
            <button
              onClick={() => void addSource()}
              disabled={adding || !addPath.trim()}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </section>

        {pickerOpen && (
          <FolderPickerDialog
            initialPath={addPath.trim() || undefined}
            onClose={() => setPickerOpen(false)}
            onSelect={(picked) => {
              setAddPath(picked);
              setPickerOpen(false);
            }}
          />
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {/* Source list */}
        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Indexed folders</label>
          {loading && sources.length === 0 && (
            <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
          )}
          {!loading && sources.length === 0 && (
            <p className="text-fg-faint text-xs italic">
              No folders yet. Add one above to start indexing.
            </p>
          )}
          {sources.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-fg break-all flex-1">
                  {s.label ? <strong>{s.label}</strong> : null}
                  {s.label ? <span className="text-fg-faint"> — </span> : null}
                  {s.path}
                </span>
                <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() => void toggleSource(s)}
                  />
                  enabled
                </label>
                <button
                  onClick={() => void reindex(s.id)}
                  disabled={busy[s.id]}
                  title="Re-scan now"
                  className="p-1 text-fg-subtle hover:text-fg disabled:opacity-40"
                >
                  <RefreshCw size={13} className={busy[s.id] ? "animate-spin" : ""} />
                </button>
                <button
                  onClick={() => void removeSource(s.id, s.path)}
                  title="Remove source"
                  className="p-1 text-fg-faint hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="text-[11px] text-fg-faint flex flex-wrap gap-x-3 gap-y-0.5">
                <span>{s.stats.document_count} files</span>
                <span>{s.stats.chunk_count} chunks</span>
                <span>{s.stats.embedded_chunk_count} embedded</span>
                {s.last_scan_at && <span>last scan: {new Date(s.last_scan_at).toLocaleString()}</span>}
              </div>
              {s.last_error && (
                <div className="text-[11px] text-red-600 dark:text-red-400 break-words">
                  Last error: {s.last_error}
                </div>
              )}
            </div>
          ))}
        </section>

        {/* Search probe */}
        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Try a search</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              placeholder="Ask something the docs would know…"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
            />
            <button
              onClick={() => void runSearch()}
              disabled={searching || !query.trim()}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
            >
              <Search size={13} /> Search
            </button>
          </div>
          {hits.length > 0 && (
            <div className="space-y-2">
              {hits.map((h) => (
                <div key={`${h.document_id}-${h.chunk_index}`} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-fg-muted truncate flex-1">
                      {h.source_label ? `${h.source_label} / ` : ""}{h.rel_path}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-fg-faint shrink-0">
                      {h.match} · {h.score.toFixed(2)}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-fg-muted text-[11px] leading-relaxed font-sans line-clamp-6">
                    {h.text}
                  </pre>
                </div>
              ))}
            </div>
          )}
          {!searching && query.trim() && hits.length === 0 && (
            <p className="text-fg-faint text-xs italic">No hits — try different terms or add more folders above.</p>
          )}
        </section>
      </div>
    </div>
  );
}
