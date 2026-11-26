"use client";
import { Database, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { DocumentIndexLifecycleResponse } from "@/api/types";

interface Props {
  lifecycle: DocumentIndexLifecycleResponse;
  busy: boolean;
  /** Chunks held by disabled sources; 0 disables the explicit purge button. */
  disabledChunks: number;
  onRefresh: () => void;
  onSaveRetention: (days: number) => Promise<void>;
  onPurgeDisabled: () => Promise<void>;
  onReclaim: () => Promise<void>;
  onRewriteEmbeddings: () => Promise<void>;
  onVacuum: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-fg-faint">{label}</div>
      <div className="mt-1 font-medium text-fg">{value}</div>
    </div>
  );
}

export function IndexMaintenance({
  lifecycle, busy, disabledChunks, onRefresh, onSaveRetention, onPurgeDisabled, onReclaim,
  onRewriteEmbeddings, onVacuum,
}: Props) {
  const { inventory, settings, status } = lifecycle;
  const [days, setDays] = useState(settings.purge_disabled_after_days);
  useEffect(() => setDays(settings.purge_disabled_after_days), [settings.purge_disabled_after_days]);
  const changed = days !== settings.purge_disabled_after_days;
  const liveReclaim = inventory.auto_vacuum === "incremental";
  const actionLabel = status.action === "purge_source" || status.action === "purge_disabled"
    ? "Purging indexed chunks…"
    : status.action === "vacuum"
      ? "Compacting the database…"
      : status.action === "rewrite_embeddings"
        ? "Rewriting embeddings…"
        : status.action === "lifecycle"
          ? "Running index lifecycle…"
          : status.action === "reclaim"
            ? "Reclaiming free pages…"
            : "Maintenance running…";

  return (
    <section className="space-y-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Database size={13} className="text-fg-subtle shrink-0" aria-hidden="true" />
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide flex-1">Index maintenance</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          title="Refresh index inventory"
          aria-label="Refresh index inventory"
          className="p-1 text-fg-subtle hover:text-fg disabled:opacity-40"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs">
        <Stat label="Documents" value={inventory.document_count.toLocaleString()} />
        <Stat label="Chunks" value={inventory.chunk_count.toLocaleString()} />
        <Stat label="Database" value={formatBytes(inventory.size_bytes)} />
        <Stat label="Reclaimable" value={formatBytes(inventory.free_bytes)} />
      </div>

      <p className="text-[11px] text-fg-faint leading-relaxed">
        Disabled sources keep their chunks so re-enabling is instant. Their indexes are never searched.
        {liveReclaim
          ? " This database reclaims freed pages incrementally."
          : " Compact the database once to enable live space reclamation; until then, purging does not shrink the file."}
      </p>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-fg-muted">Purge disabled sources after</span>
        <input
          type="number"
          min={0}
          max={3650}
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="w-20 px-2 py-1 rounded border border-border bg-surface-3 text-fg text-right"
        />
        <span className="text-fg-faint w-12">days (0 = keep)</span>
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onSaveRetention(days)}
          disabled={!changed || busy}
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          Save retention
        </button>
        <button
          type="button"
          onClick={() => void onPurgeDisabled()}
          disabled={busy || disabledChunks === 0}
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          Purge disabled
        </button>
        <button
          type="button"
          onClick={() => void onReclaim()}
          disabled={busy || !liveReclaim || inventory.free_bytes === 0}
          title={liveReclaim ? "Reclaim free pages now" : "Run database compaction first"}
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          Reclaim space
        </button>
        <button
          type="button"
          onClick={() => void onRewriteEmbeddings()}
          disabled={busy}
          title="Convert legacy JSON embeddings to compact float32 storage"
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          Rewrite embeddings
        </button>
        <button
          type="button"
          onClick={() => void onVacuum()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Trash2 size={11} aria-hidden="true" />
          Compact database
        </button>
      </div>

      {status.running && (
        <div className="text-[11px] text-fg-muted flex items-center gap-1.5" role="status">
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          {actionLabel}
        </div>
      )}
      {!status.running && status.error && (
        <div className="text-[11px] text-red-600 dark:text-red-400 break-words" role="alert">
          {status.error}
        </div>
      )}
      {!status.running && !status.error && status.summary && (
        <div className="text-[11px] text-fg-faint break-words">{status.summary}</div>
      )}
    </section>
  );
}
