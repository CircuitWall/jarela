"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type {
  DocumentHit,
  DocumentIndexLifecycleResponse,
  DocumentSource,
  DocumentSourceKind,
} from "@/api/types";
import { summarizeRemote } from "./helpers";
import { errorMessage } from "@/lib/utils/error";
import type { DocumentRecallPolicy } from "@/lib/documents/recall-policy";
import { useDocumentIndexLifecycle } from "./useDocumentIndexLifecycle";
import { useDocumentSourceMutations } from "./useDocumentSourceMutations";

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
  lifecycle: DocumentIndexLifecycleResponse | null;
  lifecycleBusy: boolean;
  saveRetention: (days: number) => Promise<void>;
  purgeSourceIndex: (id: string) => Promise<void>;
  purgeDisabledIndexes: () => Promise<void>;
  reclaimSpace: () => Promise<void>;
  compactDatabase: () => Promise<void>;
  refreshLifecycle: () => Promise<void>;
}

export function useDocumentsPanel(): UseDocumentsPanelResult {
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [recallPolicy, setRecallPolicy] = useState<DocumentRecallPolicy | null>(null);
  const [localEmbeddings, setLocalEmbeddings] = useState<boolean | null>(null);
  const [configuredIntegrations, setConfiguredIntegrations] = useState<string[]>([]);
  const indexLifecycle = useDocumentIndexLifecycle({
    sources, onError: setError, onChanged: load,
  });
  const sourceMutations = useDocumentSourceMutations({
    load, onError: setError, setLocalEmbeddings, setBusy,
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sources, recall, integrations] = await Promise.all([
        api.documents.listSources(), api.documents.getRecallPolicy(), api.integrations.list(),
        indexLifecycle.load(),
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

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { void loadRef.current(); }, []);

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

  async function purgeSourceIndex(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await indexLifecycle.purgeSourceIndex(id);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
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
    load,
    addSource: sourceMutations.addSource,
    reindex: sourceMutations.reindex,
    removeSource: sourceMutations.removeSource,
    toggleSource: sourceMutations.toggleSource,
    search,
    recallPolicy, localEmbeddings, configuredIntegrations, saveRecallPolicy,
    lifecycle: indexLifecycle.lifecycle,
    lifecycleBusy: indexLifecycle.busy,
    saveRetention: indexLifecycle.saveRetention,
    purgeSourceIndex,
    purgeDisabledIndexes: indexLifecycle.purgeDisabledIndexes,
    reclaimSpace: indexLifecycle.reclaimSpace,
    compactDatabase: indexLifecycle.compactDatabase,
    refreshLifecycle: indexLifecycle.refresh,
  };
}

// Re-export so subcomponents can import in one place.
export { summarizeRemote };
