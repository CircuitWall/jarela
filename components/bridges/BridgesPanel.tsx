"use client";
import { AlertCircle, CheckCircle2, Loader2, MessageSquareText, Plus, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Bridge, BridgeLiveStatus } from "@/api/types";
import { useBridges } from "@/hooks/useBridges";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { BridgeEditor } from "./BridgeEditor";

/**
 * Bridges panel.
 *
 * Lists configured bridges (WhatsApp adapters via Baileys). Each row shows
 * status + pair button. Clicking a row opens BridgeEditor with the routing
 * table for that bridge.
 *
 * The first WhatsApp account a user pairs is usually a throwaway / business
 * line — re-pair is destructive (wipes auth state on disk and forces a new
 * QR), so we put it behind an explicit button rather than a row toggle.
 */
export function BridgesPanel() {
  const { bridges, loading, refresh, create, update, remove } = useBridges();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("bridges", "bridge", containerRef);

  // Poll the list every 5s so status pills flip from pairing → connected as
  // Baileys' connection.update events drive the runtime status writeback.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    const b = await create({ kind: "whatsapp", name });
    setNewName("");
    setCreating(false);
    setSelectedId(b.id);
  }

  async function onDelete(b: Bridge) {
    if (!confirm(`Delete bridge "${b.name}"? This also removes its WhatsApp auth and all routes.`)) return;
    if (selectedId === b.id) setSelectedId(null);
    await remove(b.id);
  }

  async function onToggleEnabled(b: Bridge) {
    await update(b.id, { enabled: !b.enabled });
    // Status flips on next poll once Baileys opens the WS.
  }

  if (selectedId) {
    const b = bridges.find((x) => x.id === selectedId);
    if (!b) { setSelectedId(null); return null; }
    return (
      <BridgeEditor
        bridge={b}
        onBack={() => { setSelectedId(null); void refresh(); }}
        onRename={(name) => update(b.id, { name })}
        onToggleEnabled={() => onToggleEnabled(b)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Smartphone size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Bridges</h2>
        <button
          onClick={() => setCreating(true)}
          className="px-2 py-1 text-xs rounded bg-accent/15 hover:bg-accent/25 text-accent flex items-center gap-1"
        >
          <Plus size={12} /> New
        </button>
      </div>

      <div ref={containerRef} className="panel-scrollbar flex-1 overflow-y-auto px-4 py-3">
        {creating && (
          <div className="mb-3 rounded-lg border border-accent/30 bg-surface-2 p-3 space-y-2">
            <p className="text-xs text-fg-subtle">
              Create a WhatsApp bridge. After creating, enable it and scan the QR with WhatsApp → Linked Devices.
            </p>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. Personal, Support)"
              className="w-full px-2 py-1.5 text-sm bg-surface-3 rounded border border-border focus:border-accent outline-none"
              onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); if (e.key === "Escape") setCreating(false); }}
            />
            <div className="flex gap-2">
              <button onClick={onCreate} className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent/90 text-white">
                Create
              </button>
              <button onClick={() => { setCreating(false); setNewName(""); }} className="px-3 py-1 text-xs rounded text-fg-subtle hover:bg-surface-3">
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading && bridges.length === 0 && (
          <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
        )}
        {!loading && bridges.length === 0 && !creating && (
          <div className="text-fg-faint text-sm py-8 text-center space-y-2">
            <p>No bridges yet.</p>
            <p className="text-xs text-fg-faint leading-relaxed">
              A bridge connects an external comm channel (WhatsApp) to one of your agents.
              Each WhatsApp chat is routed to exactly one agent — unrouted messages are silently ignored.
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
  return (
    <div data-deep-link-id={bridge.id} className="mb-2 rounded-lg border border-border bg-surface-2 hover:bg-surface-2/70 transition-colors">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
          <MessageSquareText size={16} className="text-white" />
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
          <input
            type="checkbox"
            checked={bridge.enabled}
            onChange={onToggleEnabled}
            className="accent-accent"
          />
          {bridge.enabled ? "On" : "Off"}
        </label>

        <button
          onClick={(e) => { e.stopPropagation(); void onDelete(); }}
          className="p-1.5 rounded text-fg-faint hover:text-rose-700 dark:hover:text-rose-400 hover:bg-surface-3"
          title="Delete"
        >
          <Trash2 size={13} />
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
