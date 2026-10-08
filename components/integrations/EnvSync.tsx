"use client";
import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { errorMessage } from "@/lib/utils/error";

function sourceLabel(d: { source: string; shell?: string | null }): string {
  if (d.source === "shell-rc") return `your ${d.shell ?? "shell"} rc`;
  if (d.source === "windows-registry") return "your Windows User env";
  return "the process env";
}

// Shared by Credentials and Networking: pulls standard credential env vars
// into the Credentials list and broadcasts so any open list reloads.
export function useEnvSync() {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setSyncing(true);
    setMessage(null);
    try {
      const r = await api.envSync.apply();
      const from = sourceLabel(r.discovered);
      if (r.applied_count > 0) {
        setMessage(`Synced ${r.applied_count} field(s) from ${from}.`);
      } else {
        const userSkipped = r.candidates.filter((c) => c.action === "skipped-user").length;
        const equal = r.candidates.filter((c) => c.action === "skipped-equal").length;
        const absent = r.candidates.filter((c) => c.action === "absent").length;
        if (userSkipped > 0) setMessage(`Nothing to write \u2014 ${userSkipped} field(s) were edited here and won't be overwritten.`);
        else if (equal > 0 && absent === r.candidates.length - equal) setMessage(`Already up to date with ${from}.`);
        else setMessage(`No matching env vars set in ${from}.`);
      }
      window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  return { syncing, message, dismiss: () => setMessage(null), sync };
}

type EnvSync = ReturnType<typeof useEnvSync>;

export function EnvSyncButton({ env }: { env: EnvSync }) {
  return (
    <button
      type="button"
      onClick={() => void env.sync()}
      disabled={env.syncing}
      title="Pull standard credential env vars (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) from your shell rc / Windows User env into the Credentials list. Fields you've edited in Credentials are never overwritten."
      className="control-tap touch-manipulation inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-50"
    >
      {env.syncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
      Sync from environment
    </button>
  );
}

export function EnvSyncNotice({ env }: { env: EnvSync }) {
  if (!env.message) return null;
  return (
    <div role="status" className="px-3 py-2 rounded border border-border bg-surface-2 text-[11px] text-fg-muted flex items-start gap-2">
      <RefreshCw size={12} className="mt-0.5 text-fg-subtle shrink-0" />
      <span className="flex-1">{env.message}</span>
      <button type="button" onClick={env.dismiss} className="text-fg-faint hover:text-fg" aria-label="Dismiss">
        <XCircle size={12} />
      </button>
    </div>
  );
}
