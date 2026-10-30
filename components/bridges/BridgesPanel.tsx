"use client";
import { AlertCircle, CheckCircle2, Loader2, Plus, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { HeaderAction, PanelHeader } from "@/components/ui/PanelHeader";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Bridge, BridgeLiveStatus, BridgeModuleInfo } from "@/api/types";
import { useBridges } from "@/hooks/useBridges";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { pushErrorToast } from "@/lib/ui/error-report";
import { pushToast } from "@/lib/ui/toasts";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { BridgeEditor } from "./BridgeEditor";

import { PanelMessage } from "@/components/ui/PanelMessage";
import { confirmAction } from "@/lib/ui/confirm";

/**
 * Bridges panel.
 *
 * Lists configured bridge modules. Each row shows status; selecting it opens
 * the shared BridgeEditor and the capabilities declared by its module.
 */
export function BridgesPanel() {
  const {
    selectedId,
    bridges,
    setSelectedId,
    bridgeModules,
    refresh,
    update,
    onToggleEnabled,
    setCreating,
    containerRef,
    creating,
    newKind,
    setNewKind,
    newName,
    setNewName,
    onCreate,
    loading,
    onDelete,
  } = useBridgeManagement();

  if (selectedId) {
    const b = bridges.find((x) => x.id === selectedId);
    if (!b) { setSelectedId(null); return null; }
    const bridgeModule = bridgeModules.find((candidate) => candidate.kind === b.kind);
    if (!bridgeModule) return <PanelMessage>Loading bridge module…</PanelMessage>;
    return (
      <BridgeEditor
        bridge={b}
        module={bridgeModule}
        onBack={() => { setSelectedId(null); void refresh(); }}
        onRename={(name) => update(b.id, { name })}
        onToggleEnabled={() => onToggleEnabled(b)}
        onPatch={(patch) => update(b.id, patch)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader icon={<Smartphone size={14} />} title="Bridges">
        <HeaderAction icon={<Plus size={14} />} label="New" onClick={() => setCreating(true)} />
      </PanelHeader>

      <div ref={containerRef} className="workspace-gutter flex-1 overflow-y-auto no-scrollbar py-3">
        {creating && (
          <div className="mb-3 rounded-lg border border-accent/30 bg-surface-2 p-3 space-y-2">
            {bridgeModules.length > 1 && (
              <label className="block space-y-1 text-xs text-fg-subtle">
                <span>Channel</span>
                <select value={newKind} onChange={(event) => setNewKind(event.target.value)} className="w-full px-2 py-1.5 bg-surface-3 rounded border border-border">
                  {bridgeModules.map((module) => <option key={module.kind} value={module.kind}>{module.label}</option>)}
                </select>
              </label>
            )}
            {bridgeModules.find((module) => module.kind === newKind) && (
              <p className="text-xs text-fg-subtle">
                {bridgeModules.find((module) => module.kind === newKind)?.description}{" "}
                {bridgeModules.find((module) => module.kind === newKind)?.setupInstructions}
              </p>
            )}
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. Personal, Support)"
              className="w-full px-2 py-1.5 text-sm bg-surface-3 rounded border border-border focus:border-accent outline-none"
              onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); if (e.key === "Escape") setCreating(false); }}
            />
            <div className="flex gap-2">
              <button onClick={onCreate} disabled={!newKind} className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent/90 text-white disabled:opacity-50">
                Create
              </button>
              <button onClick={() => { setCreating(false); setNewName(""); }} className="px-3 py-1 text-xs rounded text-fg-subtle hover:bg-surface-3">
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading && bridges.length === 0 && (
          <PanelMessage>Loading…</PanelMessage>
        )}
        {!loading && bridges.length === 0 && !creating && (
          <div className="text-fg-faint text-sm py-8 text-center space-y-2">
            <p>No bridges yet.</p>
            <p className="text-xs text-fg-faint leading-relaxed">
              A bridge connects an external communication channel to your agents. Chats are routed to one agent; unrouted messages are ignored.
            </p>
          </div>
        )}

        {bridges.map((b) => (
          <BridgeRow
            key={b.id}
            bridge={b}
            onSelect={() => setSelectedId(b.id)}
            onToggleEnabled={() => onToggleEnabled(b)}
            onDelete={() => onDelete(b)}
          />
        ))}
      </div>
    </div>
  );
}

function BridgeRow({
  bridge, onSelect, onToggleEnabled, onDelete,
}: {
  bridge: Bridge;
  onSelect: () => void;
  onToggleEnabled: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div data-deep-link-id={bridge.id} className="mb-2 rounded-lg border border-border bg-surface-2 hover:bg-surface-2/70 transition-colors">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 text-white">
          <ProviderLogo name={bridge.kind} size={16} />
        </div>
        <button onClick={onSelect} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg truncate">{bridge.name}</span>
            <StatusPill status={bridge.status} />
          </div>
          <p className="text-[11px] text-fg-faint truncate mt-0.5">
            {bridge.paired_id ?? "Not paired"}
            {bridge.last_error ? ` · ${bridge.last_error}` : ""}
          </p>
        </button>

        <label className="flex items-center gap-1.5 text-[11px] text-fg-subtle cursor-pointer select-none">
          {toggling ? <Loader2 size={12} className="animate-spin text-accent" /> : (
            <input
              type="checkbox"
              checked={bridge.enabled}
              onChange={async () => {
                if (toggling) return;
                setToggling(true);
                try { await onToggleEnabled(); } finally { setToggling(false); }
              }}
              disabled={toggling}
              className="accent-accent"
            />
          )}
          {bridge.enabled ? "On" : "Off"}
        </label>

        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (deleting) return;
            setDeleting(true);
            try { await onDelete(); } finally { setDeleting(false); }
          }}
          disabled={deleting}
          className="p-1.5 rounded text-fg-faint hover:text-rose-700 dark:hover:text-rose-400 hover:bg-surface-3 transition-colors disabled:opacity-50"
          title={deleting ? "Deleting…" : "Delete"}
        >
          {deleting ? <Loader2 size={13} className="animate-spin text-rose-600 dark:text-rose-400" /> : <Trash2 size={13} />}
        </button>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: Bridge["status"] }) {
  const cfg = {
    connected:    { label: "connected",    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30", icon: <CheckCircle2 size={9} /> },
    pairing:      { label: "pairing",      cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",              icon: <Loader2 size={9} className="animate-spin" /> },
    disconnected: { label: "disconnected", cls: "bg-fg-faint/15 text-fg-subtle border-fg-faint/30",          icon: <RefreshCw size={9} /> },
    error:        { label: "error",        cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",          icon: <AlertCircle size={9} /> },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wide font-semibold ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function useBridgeManagement() {
  const { bridges, loading, refresh, create, update, remove } = useBridges();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("");
  const [bridgeModules, setBridgeModules] = useState<BridgeModuleInfo[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("bridges", "bridge", containerRef);

  useEffect(() => {
    let active = true;
    void api.bridges.kinds().then((modules) => {
      if (!active) return;
      setBridgeModules(modules);
      setNewKind((current) => current || modules[0]?.kind || "");
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Poll the list so status pills reflect asynchronous adapter updates.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onCreate() {
    const name = newName.trim();
    if (!name || !newKind) return;
    const b = await create({ kind: newKind, name });
    setNewName("");
    setCreating(false);
    setSelectedId(b.id);
  }

  async function onDelete(b: Bridge) {
    if (!(await confirmAction({ message: `Delete bridge "${b.name}"? This removes its saved connection data and all routes.`, destructive: true }))) return;
    if (selectedId === b.id) setSelectedId(null);
    try {
      await remove(b.id);
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Bridges",
        title: "Bridge deleted",
        body: `"${b.name}"`,
        agent_id: null,
        thread_id: null,
        ttl: 3000,
      });
    } catch (e) {
      pushErrorToast({ title: "Couldn't delete bridge", error: e, context: { panel: "bridges", action: "delete", bridge_id: b.id } });
    }
  }

  async function onToggleEnabled(b: Bridge) {
    try {
      await update(b.id, { enabled: !b.enabled });
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Bridges",
        title: b.enabled ? "Bridge paused" : "Bridge enabled",
        body: `"${b.name}"`,
        agent_id: null,
        thread_id: null,
        ttl: 3000,
      });
    } catch (e) {
      pushErrorToast({ title: "Couldn't toggle bridge", error: e, context: { panel: "bridges", action: "toggle", bridge_id: b.id } });
    }
  }

  return {
    selectedId,
    bridges,
    setSelectedId,
    bridgeModules,
    refresh,
    update,
    onToggleEnabled,
    setCreating,
    containerRef,
    creating,
    newKind,
    setNewKind,
    newName,
    setNewName,
    onCreate,
    loading,
    onDelete,
  };
}
