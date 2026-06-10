"use client";
import { Search } from "lucide-react";
import { useState } from "react";
import type { DocumentHit } from "@/api/types";

interface Props {
  onSearch: (query: string) => Promise<DocumentHit[]>;
}

export function SearchProbe({ onSearch }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentHit[]>([]);
  const [searching, setSearching] = useState(false);

  async function runSearch() {
    const q = query.trim();
    if (!q) { setHits([]); return; }
    setSearching(true);
    try {
      setHits(await onSearch(q));
    } finally {
      setSearching(false);
    }
  }

  return (
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
  );
}
