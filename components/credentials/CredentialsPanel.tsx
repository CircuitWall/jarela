"use client";
import { Key, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Credential, CredentialType } from "@/api/types";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { CredentialEditor } from "./CredentialEditor";

const TYPE_COLORS: Record<CredentialType, string> = {
  model: "bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-700",
  tts: "bg-rose-900/30 text-rose-700 dark:text-rose-300 border-rose-700",
  integration: "bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 border-cyan-700",
  bridge: "bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-700",
};

const TYPE_LABEL: Record<CredentialType, string> = {
  model: "Model",
  tts: "TTS",
  integration: "Integration",
  bridge: "Bridge",
};

export function CredentialsPanel() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<string[]>([]);
  const [editing, setEditing] = useState<Credential | null | { type: CredentialType }>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("credentials", "credential", containerRef);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.credentials.list();
      setCredentials(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.models.providers().then(setProviders).catch(() => setProviders([]));
    const onChange = () => refresh();
    if (typeof window !== "undefined") window.addEventListener("jarela:credentials-changed", onChange);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("jarela:credentials-changed", onChange);
    };
  }, [refresh]);

  async function handleDelete(id: string) {
    setDeleteError(null);
    try {
      await api.credentials.delete(id);
      // The custom event fires from the client; refresh as a belt-and-braces.
      refresh();
    } catch (e) {
      setDeleteError(`Could not delete "${id}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Group credentials by type so the panel renders one section per
  // bucket (Models first, then the rest as they grow).
  const grouped = useMemo(() => {
    const byType = new Map<CredentialType, Credential[]>();
    for (const c of credentials) {
      const arr = byType.get(c.type) ?? [];
      arr.push(c);
      byType.set(c.type, arr);
    }
    return Array.from(byType.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [credentials]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Key size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Credentials</h2>
        <div className="flex items-center gap-1">
          {/* Typed Add menu — one button per credential type so the user
              picks the bucket up front rather than having to set a
              dropdown after opening. */}
          <button onClick={() => setEditing({ type: "model" })} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors" title="Add a model-provider credential (API key or OAuth)">
            <Plus size={14} /> Model
          </button>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 space-y-4">
          {loading && credentials.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}
          {!loading && credentials.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">
              No credentials yet. Click <span className="font-medium">+ Model</span> to add your first one — or open a model config and use its credential picker.
            </p>
          )}
          {deleteError && (
            <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{deleteError}</p>
          )}
          {grouped.map(([type, rows]) => (
            <section key={type}>
              <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-1 px-1">{TYPE_LABEL[type]}</h3>
              <div className="divide-y divide-border/60 border border-border/60 rounded-xl overflow-hidden bg-surface-2/40">
                {rows.map((c) => (
                  <div key={c.id} data-deep-link-id={c.id} className="flex items-center gap-3 px-3 py-2.5 group">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-mono text-fg truncate">{c.id}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${TYPE_COLORS[c.type]}`}>{c.type}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border">{c.provider}</span>
                        <span className="text-[10px] text-fg-faint">{c.auth_method}</span>
                      </div>
                      <p className="text-[11px] text-fg-subtle">
                        {c.auth_method === "api_key"
                          ? (c.params.api_key ? "API key configured" : "API key missing")
                          : (c.params.refresh_token ? "Refresh token stored" : "OAuth pending")}
                        {c.params.base_url && <span className="ml-2 truncate">• base: {c.params.base_url}</span>}
                      </p>
                    </div>
                    <div className="flex gap-1 opacity-40 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                      <button onClick={() => setEditing(c)} className="p-1 text-fg-subtle hover:text-fg transition-colors" title="Edit">
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(c.id)}
                        className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {editing !== null && (
        <CredentialEditor
          credential={"id" in editing ? editing : undefined}
          defaults={"id" in editing ? undefined : { type: editing.type }}
          providers={providers}
          lockType={!("id" in editing) && editing.type !== "model"}
          onSaved={() => refresh()}
          onClose={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
