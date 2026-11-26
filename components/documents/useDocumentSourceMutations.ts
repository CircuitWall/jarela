"use client";
import { api } from "@/api/client";
import type { DocumentSource, DocumentSourceKind } from "@/api/types";
import { errorMessage } from "@/lib/utils/error";
import { pushToast } from "@/lib/ui/toasts";
import { confirmAction } from "@/lib/ui/confirm";
import { isMailKind } from "./helpers";

interface Options {
  /** Reloads sources and counters after a mutation. */
  load: () => Promise<void>;
  onError: (message: string | null) => void;
  setLocalEmbeddings: (enabled: boolean) => void;
  setBusy: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export interface UseDocumentSourceMutationsResult {
  addSource: (payload: Parameters<typeof api.documents.createSource>[0]) => Promise<boolean>;
  reindex: (id: string) => Promise<void>;
  removeSource: (id: string, summary: string, kind: DocumentSourceKind) => Promise<void>;
  toggleSource: (source: DocumentSource) => Promise<void>;
  confirmEmbeddingDisclosure: () => Promise<boolean>;
}

export function useDocumentSourceMutations({
  load, onError, setLocalEmbeddings, setBusy,
}: Options): UseDocumentSourceMutationsResult {
  async function confirmEmbeddingDisclosure(): Promise<boolean> {
    const current = await api.documents.getRecallPolicy();
    setLocalEmbeddings(current.local_embeddings);
    return current.local_embeddings || confirmAction({
      message: "The embedding provider is not Jarela Local. Indexed document content may be sent to an external service, including content later excluded from recall. Continue?",
      confirmLabel: "Allow indexing",
    });
  }

  async function addSource(payload: Parameters<typeof api.documents.createSource>[0]) {
    onError(null);
    try {
      if (!(await confirmEmbeddingDisclosure())) return false;
      await api.documents.createSource(payload);
      await load();
      return true;
    } catch (e) {
      onError(errorMessage(e));
      throw e;
    }
  }

  async function reindex(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      if (!(await confirmEmbeddingDisclosure())) return;
      const result = await api.documents.reindex(id);
      if ((result.stats.embed_failed ?? 0) > 0) {
        onError(
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
      onError(errorMessage(e));
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
      onError(errorMessage(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function toggleSource(source: DocumentSource) {
    try {
      if (!source.enabled && !(await confirmEmbeddingDisclosure())) return;
      await api.documents.updateSource(source.id, { enabled: !source.enabled });
      await load();
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  return { addSource, reindex, removeSource, toggleSource, confirmEmbeddingDisclosure };
}
