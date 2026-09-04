"use client";

import { Archive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { ArtifactCleanupResult, ArtifactLifecycleResponse, ArtifactLifecycleSettings } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { pushToast } from "@/lib/ui/toasts";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function ArtifactLifecyclePanel() {
  const [state, setState] = useState<ArtifactLifecycleResponse | null>(null);
  const [draft, setDraft] = useState<ArtifactLifecycleSettings | null>(null);
  const [preview, setPreview] = useState<ArtifactCleanupResult | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "preview" | "cleanup" | null>(null);

  const refresh = useCallback(async () => {
    setBusy((current) => current ?? "load");
    try {
      const next = await api.artifacts.lifecycle();
      setState(next);
      setDraft(next.settings);
      setPreview(null);
    } catch (err) {
      pushErrorToast({ title: "Couldn't load artifact lifecycle", error: err, context: { panel: "artifact-lifecycle" } });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save() {
    if (!draft) return;
    setBusy("save");
    try {
      const next = await api.artifacts.updateLifecycle(draft);
      setState(next);
      setDraft(next.settings);
      setPreview(null);
      pushToast({ kind: "info", source: "system", sourceLabel: "Artifacts", title: "Lifecycle saved", body: `${next.settings.retention_days} days · ${next.settings.max_total_mb} MB`, agent_id: null, thread_id: null, ttl: 2500 });
    } catch (err) {
      pushErrorToast({ title: "Couldn't save artifact lifecycle", error: err, context: { panel: "artifact-lifecycle", action: "save" } });
    } finally {
      setBusy(null);
    }
  }

  async function dryRun() {
    setBusy("preview");
    try {
      const next = await api.artifacts.cleanup({ dryRun: true });
      setPreview(next.result);
    } catch (err) {
      pushErrorToast({ title: "Couldn't preview cleanup", error: err, context: { panel: "artifact-lifecycle", action: "preview" } });
    } finally {
      setBusy(null);
    }
  }

  async function cleanup() {
    if (!confirm("Delete lifecycle-managed browser and generated artifacts that match this policy?\n\nThis does not delete chats, agents, credentials, or memory.")) return;
    setBusy("cleanup");
    try {
      const next = await api.artifacts.cleanup({ dryRun: false });
      await refresh();
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Artifacts",
        title: "Artifacts cleaned",
        body: `${plural(next.result.deleted_count, "file")} · ${formatBytes(next.result.deleted_bytes)}`,
        agent_id: null,
        thread_id: null,
        ttl: 3500,
      });
    } catch (err) {
      pushErrorToast({ title: "Couldn't clean artifacts", error: err, context: { panel: "artifact-lifecycle", action: "cleanup" } });
    } finally {
      setBusy(null);
    }
  }

  if (!state || !draft) {
    return (
      <section className="rounded-xl border border-border bg-surface-2/70 p-4 text-sm text-fg-muted">
        Loading artifact lifecycle…
      </section>
    );
  }

  const inv = state.inventory;
  const changed = JSON.stringify(draft) !== JSON.stringify(state.settings);

  return (
    <section className="rounded-xl border border-border bg-surface-2/70 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Archive size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-fg">Artifact lifecycle</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy !== null}
          className="ml-auto p-1 rounded text-fg-faint hover:text-fg hover:bg-surface-3 disabled:opacity-50"
          title="Refresh artifact inventory"
        >
          {busy === "load" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Controls local files produced by browser reads, screenshots, generated media, and similar tool artifacts under the Jarela files directory.
      </p>

      <div className="grid grid-cols-3 gap-2 text-xs mb-3">
        <div className="rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-fg-faint">Files</div>
          <div className="mt-1 font-medium text-fg">{inv.total_files}</div>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-fg-faint">Total</div>
          <div className="mt-1 font-medium text-fg">{formatBytes(inv.total_bytes)}</div>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-fg-faint">Browser</div>
          <div className="mt-1 font-medium text-fg">{formatBytes(inv.browser_bytes)}</div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-fg-muted">Retention</span>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.retention_days}
            onChange={(event) => setDraft({ ...draft, retention_days: Number(event.target.value) })}
            className="w-24 px-2 py-1 rounded border border-border bg-surface-3 text-fg text-right"
          />
          <span className="text-fg-faint w-10">days</span>
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-fg-muted">Storage cap</span>
          <input
            type="number"
            min={16}
            max={10240}
            value={draft.max_total_mb}
            onChange={(event) => setDraft({ ...draft, max_total_mb: Number(event.target.value) })}
            className="w-24 px-2 py-1 rounded border border-border bg-surface-3 text-fg text-right"
          />
          <span className="text-fg-faint w-10">MB</span>
        </label>
        <label className="flex items-center justify-between gap-3 text-xs py-1">
          <span className="text-fg-muted">Include browser extracts and screenshots</span>
          <input
            type="checkbox"
            checked={draft.include_browser_artifacts}
            onChange={(event) => setDraft({ ...draft, include_browser_artifacts: event.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs py-1">
          <span className="text-fg-muted">Include generated media</span>
          <input
            type="checkbox"
            checked={draft.include_generated_media}
            onChange={(event) => setDraft({ ...draft, include_generated_media: event.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!changed || busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save policy"}
        </button>
        <button
          type="button"
          onClick={() => void dryRun()}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
        >
          {busy === "preview" ? "Checking…" : "Preview cleanup"}
        </button>
        <button
          type="button"
          onClick={() => void cleanup()}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Trash2 size={11} />
          {busy === "cleanup" ? "Cleaning…" : "Clean now"}
        </button>
      </div>

      {preview && (
        <div className="mt-3 rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5 text-xs text-fg-muted">
          Preview would delete {plural(preview.deleted_count, "file")} and free {formatBytes(preview.deleted_bytes)}.
        </div>
      )}

      {inv.files.length > 0 && (
        <div className="mt-3 border-t border-border/50 pt-2">
          <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-1">Recent artifacts</div>
          <ul className="space-y-1">
            {inv.files.slice(0, 5).map((file) => (
              <li key={file.name} className="flex items-center gap-2 text-[11px] text-fg-muted">
                <span className="font-mono truncate flex-1" title={file.name}>{file.name}</span>
                <span className="shrink-0 text-fg-faint">{file.kind}</span>
                <span className="shrink-0 text-fg-faint">{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
