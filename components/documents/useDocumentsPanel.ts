"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DocumentHit, DocumentSource, DocumentSourceKind } from "@/api/types";
import { isMailKind, summarizeRemote } from "./helpers";
import { errorMessage } from "@/lib/utils/error";
import { pushToast } from "@/lib/ui/toasts";

import { confirmAction } from "@/lib/ui/confirm";

export interface UseDocumentsPanelResult {
  sources: DocumentSource[];
  loading: boolean;
  error: string | null;
  busy: Record<string, boolean>;
  load: () => Promise<void>;
  addSource: (payload: Parameters<typeof api.documents.createSource>[0]) => Promise<void>;
  reindex: (id: string) => Promise<void>;
  removeSource: (id: string, summary: string, kind: DocumentSourceKind) => Promise<void>;
  toggleSource: (s: DocumentSource) => Promise<void>;
  search: (q: string) => Promise<DocumentHit[]>;
}

export function useDocumentsPanel(): UseDocumentsPanelResult {
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSources(await api.documents.listSources());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function addSource(payload: Parameters<typeof api.documents.createSource>[0]) {
    setError(null);
    try {
      await api.documents.createSource(payload);
      await load();
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  async function reindex(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const result = await api.documents.reindex(id);
      if ((result.stats.embed_failed ?? 0) > 0) {
        setError(
          `Embedding degraded: ${result.stats.embed_failed} chunk${result.stats.embed_failed === 1 ? "" : "s"} failed to embed` +
          (result.stats.embed_error ? ` (${result.stats.embed_error})` : ""),
        );
      } else {
        pushToast({
          kind: "info",
          source: "system",
          sourceLabel: "Documents",
          title: "Source re-indexed",
          body: `Re-scanned ${result.stats.scanned} files (${result.stats.added} added, ${result.stats.updated} updated).`,
          agent_id: null,
          thread_id: null,
          ttl: 4000,
        });
      }
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function removeSource(id: string, summary: string, kind: DocumentSourceKind) {
    const tail = kind === "local_folder"
      ? "Files on disk are untouched."
      : isMailKind(kind)
        ? "The upstream mailbox is untouched."
        : "The upstream content is untouched.";
    if (!(await confirmAction({ message: `Stop indexing ${summary}? This deletes all chunks for this source. ${tail}`, destructive: true, confirmLabel: "Stop indexing" }))) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await api.documents.deleteSource(id);
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Documents",
        title: "Source removed",
        body: `Stopped indexing "${summary}".`,
        agent_id: null,
        thread_id: null,
        ttl: 3000,
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function toggleSource(s: DocumentSource) {
    try {
      await api.documents.updateSource(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function search(q: string): Promise<DocumentHit[]> {
    try {
      const res = await api.documents.search(q, { limit: 8 });
      return res.hits;
    } catch (e) {
      setError(errorMessage(e));
      return [];
    }
  }

  return {
    sources, loading, error, busy,
    load, addSource, reindex, removeSource, toggleSource, search,
  };
}

// Re-export so subcomponents can import in one place.
export { summarizeRemote };
