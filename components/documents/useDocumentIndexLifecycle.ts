"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type {
  DocumentIndexLifecycleResponse,
  DocumentIndexMaintenanceAction,
  DocumentSource,
} from "@/api/types";
import { errorMessage } from "@/lib/utils/error";
import { pushToast } from "@/lib/ui/toasts";
import { confirmAction } from "@/lib/ui/confirm";
import { summarizeRemote } from "./helpers";

interface Options {
  sources: DocumentSource[];
  onError: (message: string | null) => void;
  /** Reloads sources and their counters after an action changes the index. */
  onChanged: () => Promise<void>;
}

export interface UseDocumentIndexLifecycleResult {
  lifecycle: DocumentIndexLifecycleResponse | null;
  busy: boolean;
  load: () => Promise<DocumentIndexLifecycleResponse>;
  refresh: () => Promise<void>;
  saveRetention: (days: number) => Promise<void>;
  purgeSourceIndex: (id: string) => Promise<void>;
  purgeDisabledIndexes: () => Promise<void>;
  reclaimSpace: () => Promise<void>;
  rewriteEmbeddings: () => Promise<void>;
  compactDatabase: () => Promise<void>;
}

export function useDocumentIndexLifecycle({
  sources, onError, onChanged,
}: Options): UseDocumentIndexLifecycleResult {
  const [lifecycle, setLifecycle] = useState<DocumentIndexLifecycleResponse | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the polling effect from restarting on every parent render; it only
  // needs the latest callback when the action settles.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  async function load(): Promise<DocumentIndexLifecycleResponse> {
    const next = await api.documents.getIndexLifecycle();
    setLifecycle(next);
    return next;
  }

  async function refresh() {
    setLifecycle(await api.documents.getIndexLifecycle());
  }

  // The server runs maintenance on a writer worker and answers POST with
  // 202. Poll until it settles so the panel shows live progress and then
  // picks up the refreshed source counters.
  async function waitForMaintenance() {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const next = await api.documents.getIndexLifecycle();
      setLifecycle(next);
      if (!next.status.running) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function runMaintenance(action: DocumentIndexMaintenanceAction) {
    setBusy(true);
    onError(null);
    try {
      await api.documents.runIndexMaintenance(action);
      await waitForMaintenance();
      await onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // A lifecycle sweep can also start from the scheduler; keep the panel live
  // while it runs even when this tab did not start it.
  useEffect(() => {
    if (!lifecycle?.status.running) return;
    const timer = setInterval(() => {
      void api.documents.getIndexLifecycle().then((next) => {
        setLifecycle(next);
        if (!next.status.running) void onChangedRef.current();
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [lifecycle?.status.running]);

  async function saveRetention(days: number) {
    setBusy(true);
    onError(null);
    try {
      const next = await api.documents.setIndexLifecycle({ purge_disabled_after_days: days });
      setLifecycle(next);
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Documents",
        title: "Index retention saved",
        body: next.settings.purge_disabled_after_days === 0
          ? "Disabled sources keep their index until you purge it."
          : `Disabled sources are purged after ${next.settings.purge_disabled_after_days} days.`,
        agent_id: null,
        thread_id: null,
        ttl: 3500,
      });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function purgeSourceIndex(id: string) {
    const source = sources.find((candidate) => candidate.id === id);
    const summary = source
      ? (source.kind === "local_folder" ? source.path : summarizeRemote(source))
      : id;
    if (!(await confirmAction({
      message: `Delete every indexed chunk for ${summary}? The source stays configured and files or upstream content are untouched; the next scan re-indexes it.`,
      destructive: true,
      confirmLabel: "Delete index",
    }))) return;
    await runMaintenance({ action: "purge_source", source_id: id });
  }

  async function purgeDisabledIndexes() {
    const count = sources.filter((source) => !source.enabled && source.stats.chunk_count > 0).length;
    if (count === 0) return;
    if (!(await confirmAction({
      message: `Delete the indexed chunks for ${count} disabled source${count === 1 ? "" : "s"}? The sources stay configured; re-enabling one re-indexes it.`,
      destructive: true,
      confirmLabel: "Purge indexes",
    }))) return;
    await runMaintenance({ action: "purge_disabled" });
  }

  async function reclaimSpace() {
    await runMaintenance({ action: "reclaim" });
  }

  async function rewriteEmbeddings() {
    if (!(await confirmAction({
      message: "Rewrite legacy JSON embeddings to compact float32 storage? Vectors are preserved at float32 precision. This can take a while on a large index and writes to the database while search continues to work.",
      confirmLabel: "Rewrite embeddings",
    }))) return;
    await runMaintenance({ action: "rewrite_embeddings" });
  }

  async function compactDatabase() {
    if (!(await confirmAction({
      message: "Compacting rewrites the entire database and can take several minutes on a multi-GB file. Jarela stays responsive, but SQLite holds the write lock, so other writes may wait or fail until it finishes. Free disk space for a compacted copy is required. Continue?",
      destructive: true,
      confirmLabel: "Compact database",
    }))) return;
    await runMaintenance({ action: "vacuum", confirm: true });
  }

  return {
    lifecycle, busy, load, refresh, saveRetention,
    purgeSourceIndex, purgeDisabledIndexes, reclaimSpace, rewriteEmbeddings, compactDatabase,
  };
}
