"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DocumentHit, DocumentSource, DocumentSourceKind } from "@/api/types";
import { isMailKind, summarizeRemote } from "./helpers";
import { errorMessage } from "@/lib/utils/error";
import { pushToast } from "@/lib/ui/toasts";

import { confirmAction } from "@/lib/ui/confirm";
import type { DocumentRecallPolicy } from "@/lib/documents/recall-policy";

export interface UseDocumentsPanelResult {
  sources: DocumentSource[];
  loading: boolean;
  error: string | null;
  busy: Record<string, boolean>;
  load: () => Promise<void>;
  addSource: (payload: Parameters<typeof api.documents.createSource>[0]) => Promise<boolean>;
  reindex: (id: string) => Promise<void>;
  removeSource: (id: string, summary: string, kind: DocumentSourceKind) => Promise<void>;
  toggleSource: (s: DocumentSource) => Promise<void>;
  search: (q: string, includeExcluded?: boolean) => Promise<DocumentHit[]>;
  recallPolicy: DocumentRecallPolicy | null;
  localEmbeddings: boolean | null;
  configuredIntegrations: string[];
  saveRecallPolicy: (policy: DocumentRecallPolicy) => Promise<void>;
}

export function useDocumentsPanel(): UseDocumentsPanelResult {
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [recallPolicy, setRecallPolicy] = useState<DocumentRecallPolicy | null>(null);
  const [localEmbeddings, setLocalEmbeddings] = useState<boolean | null>(null);
  const [configuredIntegrations, setConfiguredIntegrations] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sources, recall, integrations] = await Promise.all([
        api.documents.listSources(), api.documents.getRecallPolicy(), api.integrations.list(),
      ]);
      setSources(sources);
      setRecallPolicy(recall.policy);
      setLocalEmbeddings(recall.local_embeddings);
      setConfiguredIntegrations(integrations.statuses.filter((s) => s.configured).map((s) => s.name));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function confirmEmbeddingDisclosure(): Promise<boolean> {
    const current = await api.documents.getRecallPolicy();
    setLocalEmbeddings(current.local_embeddings);
    return current.local_embeddings || confirmAction({
      message: "The embedding provider is not Jarela Local. Indexed document content may be sent to an external service, including content later excluded from recall. Continue?",
      confirmLabel: "Allow indexing",
    });
  }

  async function saveRecallPolicy(policy: DocumentRecallPolicy) {
    setError(null);
    try {
      const updated = await api.documents.setRecallPolicy(policy);
      setRecallPolicy(updated.policy);
      setLocalEmbeddings(updated.local_embeddings);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  async function addSource(payload: Parameters<typeof api.documents.createSource>[0]) {
    setError(null);
    try {
      if (!(await confirmEmbeddingDisclosure())) return false;
      await api.documents.createSource(payload);
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  async function reindex(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      if (!(await confirmEmbeddingDisclosure())) return;
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
      if (!s.enabled && !(await confirmEmbeddingDisclosure())) return;
      await api.documents.updateSource(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function search(q: string, includeExcluded = false): Promise<DocumentHit[]> {
    setError(null);
    try {
      const res = await api.documents.search(q, { limit: 25, include_excluded: includeExcluded });
      return res.hits;
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  return {
    sources, loading, error, busy,
    load, addSource, reindex, removeSource, toggleSource, search,
    recallPolicy, localEmbeddings, configuredIntegrations, saveRecallPolicy,
  };
}

// Re-export so subcomponents can import in one place.
export { summarizeRemote };
