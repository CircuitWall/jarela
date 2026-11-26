"use client";
import { Search } from "lucide-react";
import { useState } from "react";
import type { DocumentHit, DocumentSearchCoverage, DocumentSearchResponse } from "@/api/types";

interface Props {
  onSearch: (query: string, includeExcluded?: boolean) => Promise<DocumentSearchResponse>;
  onExclude: (hit: DocumentHit) => Promise<void>;
}

interface PreviewGroup {
  documentId: string;
  sourceLabel: string | null;
  relPath: string;
  hits: DocumentHit[];
}

function groupPreviewHits(hits: DocumentHit[]): PreviewGroup[] {
  const groups = new Map<string, PreviewGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.document_id);
    if (!group) {
      if (groups.size >= 5) continue;
      group = {
        documentId: hit.document_id,
        sourceLabel: hit.source_label,
        relPath: hit.rel_path,
        hits: [],
      };
      groups.set(hit.document_id, group);
    }
    if (group.hits.length < 2) group.hits.push(hit);
  }
  return Array.from(groups.values());
}

export function SearchProbe({ onSearch, onExclude }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentHit[]>([]);
  const [coverage, setCoverage] = useState<DocumentSearchCoverage | null>(null);
  const [searching, setSearching] = useState(false);
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [searched, setSearched] = useState(false);
  const groups = groupPreviewHits(hits);

  async function runSearch() {
    const q = query.trim();
    if (!q) { setHits([]); setCoverage(null); return; }
    setSearching(true);
    setSearched(false);
    try {
      const result = await onSearch(q, includeExcluded);
      setHits(result.hits);
      setCoverage(result.coverage);
      setSearched(true);
    } catch {
      setHits([]);
      setCoverage(null);
      // The panel surfaces search errors.
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="space-y-2">
      <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Search and exclude documents</label>
      <p className="text-xs text-fg-faint">
        Search a topic, then exclude matching documents from assistant retrieval across all indexed sources.
        Results are ranked and limited, not an exhaustive topic audit.
      </p>
      <label className="flex gap-2 items-start text-xs text-fg-muted">
        <input type="checkbox" checked={includeExcluded} disabled={searching} onChange={(e) => {
          setIncludeExcluded(e.target.checked);
          setHits([]);
          setSearched(false);
        }} />
        Include excluded content for this preview only. This does not authorize the assistant to retrieve it.
      </label>
      <p className="text-xs text-fg-faint">The search query uses your embedding provider; preview excerpts are displayed here, not sent to the chat model.</p>
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
      {coverage?.truncated && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400" role="status">
          Scored {coverage.scanned_chunks.toLocaleString()} of {coverage.total_chunks.toLocaleString()} candidate chunks;
          these results are partial. Narrow the search with a source scope or a more specific query.
        </p>
      )}
      {hits.length > 0 && (
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.documentId} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
              <div className="flex items-center mb-1">
                <span className="font-mono text-fg-muted truncate flex-1">
                  {group.sourceLabel ? `${group.sourceLabel} / ` : ""}{group.relPath}
                </span>
                {group.hits[0]?.excluded ? (
                  <span className="text-fg-faint ml-2">Document excluded</span>
                ) : (
                  <button type="button" disabled={searching} className="text-accent ml-2 shrink-0"
                    onClick={async () => {
                      setSearching(true);
                      try {
                        await onExclude(group.hits[0]);
                        setHits((current) => current.filter((hit) => hit.document_id !== group.documentId));
                      } catch {
                        // The panel surfaces save errors.
                      } finally {
                        setSearching(false);
                      }
                    }}>Exclude document</button>
                )}
              </div>
              <div className="space-y-2">
                {group.hits.map((hit) => (
                  <div key={hit.chunk_index} className="border-t border-border/60 pt-1.5 first:border-t-0 first:pt-0">
                    <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-0.5">
                      Chunk {hit.chunk_index + 1} · {hit.match} · {hit.score.toFixed(2)}
                    </div>
                    <pre className="whitespace-pre-wrap text-fg-muted text-[11px] leading-relaxed font-sans line-clamp-6">
                      {hit.text}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {!searching && searched && query.trim() && hits.length === 0 && (
        <p className="text-fg-faint text-xs italic">No hits — try different terms or add more folders above.</p>
      )}
    </section>
  );
}
