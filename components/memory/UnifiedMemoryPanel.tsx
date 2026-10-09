"use client";
import { useState } from "react";
import { Brain, ChevronRight, FolderSearch, Loader2, Search } from "lucide-react";
import type { DocumentHit, MemorySearchHit } from "@/api/types";
import { api } from "@/api/client";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextField";
import { PanelHeader } from "@/components/ui/PanelHeader";
import { errorMessage } from "@/lib/utils/error";
import { MemoryPanel } from "./MemoryPanel";
import { DocumentsPanel } from "@/components/documents/DocumentsPanel";

type ChannelFilter = "all" | "documents" | "chats";
type PassageMatch = "semantic" | "substring" | "keyword" | "literal";

interface DocumentGroup {
  id: string;
  channel: "Documents";
  path: string;
  sourceLabel: string | null;
  score: number;
  match: PassageMatch;
  ranking: number;
  passages: DocumentHit[];
}

interface ChatGroup {
  id: string;
  channel: "Chats";
  threadId: string;
  score: number;
  match: PassageMatch;
  ranking: number;
  passages: MemorySearchHit[];
}

type SearchResult = DocumentGroup | ChatGroup;

const MAX_GROUPS_PER_CHANNEL = 8;
const MAX_PASSAGES_PER_GROUP = 2;
const MAX_PASSAGE_CHARS = 1_200;

function normalizedRanking(score: number, match: PassageMatch, floor: number): number {
  if (match === "literal") return 2;
  if (match !== "semantic") return 0;
  return (score - floor) / (1 - floor);
}

function groupDocumentHits(hits: DocumentHit[], minSimilarity: number): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.document_id);
    if (!group) {
      if (groups.size >= MAX_GROUPS_PER_CHANNEL) continue;
      const match = hit.match as PassageMatch;
      group = {
        id: `document:${hit.document_id}`,
        channel: "Documents",
        path: hit.rel_path,
        sourceLabel: hit.source_label,
        score: hit.score,
        match,
        ranking: normalizedRanking(hit.score, match, minSimilarity),
        passages: [],
      };
      groups.set(hit.document_id, group);
    }
    if (group.passages.length < MAX_PASSAGES_PER_GROUP) group.passages.push(hit);
  }
  return Array.from(groups.values());
}

function groupChatHits(hits: MemorySearchHit[], minSimilarity: number): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  for (const hit of hits) {
    if (hit.source !== "message" || !hit.thread_id) continue;
    let group = groups.get(hit.thread_id);
    if (!group) {
      if (groups.size >= MAX_GROUPS_PER_CHANNEL) continue;
      const match = (hit.match ?? "semantic") as PassageMatch;
      group = {
        id: `chat:${hit.thread_id}`,
        channel: "Chats",
        threadId: hit.thread_id,
        score: hit.score,
        match,
        ranking: normalizedRanking(hit.score, match, minSimilarity),
        passages: [],
      };
      groups.set(hit.thread_id, group);
    }
    if (group.passages.length < MAX_PASSAGES_PER_GROUP) group.passages.push(hit);
  }
  return Array.from(groups.values());
}

function truncate(text: string): string {
  return text.length > MAX_PASSAGE_CHARS
    ? `${text.slice(0, MAX_PASSAGE_CHARS - 3).trimEnd()}...`
    : text;
}

export function UnifiedMemoryPanel() {
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    const [documents, chats] = await Promise.allSettled([
      channel === "chats" ? Promise.resolve(null) : api.documents.search(q, { limit: 25 }),
      channel === "documents" ? Promise.resolve(null) : api.memory.search(q, { source: "messages", limit: 25 }),
    ]);
    const errors: string[] = [];
    const documentGroups = documents.status === "fulfilled" && documents.value
      ? groupDocumentHits(documents.value.hits, documents.value.min_similarity)
      : [];
    const chatGroups = chats.status === "fulfilled" && chats.value
      ? groupChatHits(chats.value.hits, chats.value.min_chat_similarity ?? 0.25)
      : [];
    if (documents.status === "rejected") errors.push(errorMessage(documents.reason));
    if (chats.status === "rejected") errors.push(errorMessage(chats.reason));
    setResults([...documentGroups, ...chatGroups].sort((a, b) => b.ranking - a.ranking));
    setError(errors.length ? errors.join("; ") : null);
    setSearching(false);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader icon={<Brain size={14} />} title="Memory" />
      <div className="px-4 py-3 border-b border-border space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" />
            <TextInput
              className="pl-7"
              placeholder="Search documents and chats…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }}
            />
          </div>
          <Select aria-label="Search channel" full={false} value={channel} onChange={(event) => setChannel(event.target.value as ChannelFilter)}>
            <option value="all">All channels</option>
            <option value="documents">Documents</option>
            <option value="chats">Chats</option>
          </Select>
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={searching || !query.trim()}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
          >
            {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            Search
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {results.length > 0 && (
          <section aria-label="Search results" className="px-4 py-3 space-y-2">
            {results.map((result, index) => (
              <article key={result.id} className="border-b border-border/60 py-2.5 last:border-b-0">
                <div className="flex items-center gap-2 mb-1">
                  {result.channel === "Documents" ? <FolderSearch size={12} className="text-fg-faint" /> : <Brain size={12} className="text-fg-faint" />}
                  <span className="text-[10px] uppercase tracking-wide text-fg-faint">#{index + 1} · {result.channel} · {result.match}</span>
                </div>
                {result.channel === "Documents" ? (
                  <>
                    <div className="font-mono text-xs text-fg-muted truncate mb-1">
                      {result.sourceLabel ? `${result.sourceLabel} / ` : ""}{result.path}
                    </div>
                    {result.passages.map((passage) => (
                      <pre key={`${passage.document_id}:${passage.chunk_index}`} className="whitespace-pre-wrap text-fg-muted text-[11px] leading-relaxed font-sans line-clamp-5 mt-1.5">
                        {truncate(passage.text)}
                      </pre>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="font-mono text-[10px] text-fg-faint mb-1">Conversation {result.threadId.slice(0, 8)}</div>
                    {result.passages.map((passage) => (
                      <pre key={`${result.threadId}:${passage.created_at}`} className="whitespace-pre-wrap text-fg-muted text-[11px] leading-relaxed font-sans line-clamp-5 mt-1.5">
                        {truncate(passage.content)}
                      </pre>
                    ))}
                  </>
                )}
              </article>
            ))}
          </section>
        )}
        {!searching && query.trim() && results.length === 0 && !error && (
          <p className="text-fg-faint text-sm text-center py-8">No matching results</p>
        )}

        <details className="group border-t border-border">
          <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none text-sm font-medium text-fg hover:bg-surface-3/30">
            <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
            <Brain size={14} className="text-fg-faint" />
            Saved facts
          </summary>
          <MemoryPanel embedded />
        </details>
        <details className="group border-t border-border">
          <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none text-sm font-medium text-fg hover:bg-surface-3/30">
            <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
            <FolderSearch size={14} className="text-fg-faint" />
            Documents
          </summary>
          <DocumentsPanel embedded />
        </details>
      </div>
    </div>
  );
}