"use client";
import { ArrowLeft, Plus, QrCode, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Bridge, BridgeLiveStatus, BridgeRoute } from "@/api/types";
import { useBridgeRoutes } from "@/hooks/useBridges";
import { StatusPill } from "./BridgesPanel";

/**
 * Single-bridge editor: shows live status (QR while pairing, paired ID once
 * connected), exposes the re-pair button, and embeds the routing table that
 * binds WhatsApp chats (JIDs) to agents.
 *
 * Routes have a `UNIQUE(agent_id)` constraint server-side — each agent is
 * the target of at most one route across all bridges. The single-thread-per-
 * agent invariant carries over from the rest of LangGUI: the bridge enqueues
 * inbound text into that agent's existing thread.
 */
export function BridgeEditor({
  bridge, onBack, onRename, onToggleEnabled,
}: {
  bridge: Bridge;
  onBack: () => void;
  onRename: (name: string) => Promise<unknown>;
  onToggleEnabled: () => Promise<unknown> | unknown;
}) {
  const [name, setName] = useState(bridge.name);
  const [savingName, setSavingName] = useState(false);
  const [live, setLive] = useState<BridgeLiveStatus | null>(null);
  const [repairing, setRepairing] = useState(false);

  // Poll live status while pairing so the QR shows up quickly, then slow
  // down once we're stable.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (!alive) return;
      try {
        const s = await api.bridges.status(bridge.id);
        if (!alive) return;
        setLive(s);
        timer = setTimeout(tick, s.status === "pairing" ? 1500 : 5000);
      } catch {
        timer = setTimeout(tick, 5000);
      }
    }
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [bridge.id]);

  async function saveName() {
    if (name.trim() === bridge.name || !name.trim()) return;
    setSavingName(true);
    try { await onRename(name.trim()); }
    finally { setSavingName(false); }
  }

  async function rePair() {
    if (!confirm("Re-pair this bridge? This wipes the current WhatsApp session and shows a new QR code.")) return;
    setRepairing(true);
    try {
      await api.bridges.pair(bridge.id);
      // Re-pairing also enables the bridge if it was off, so the QR fires.
      if (!bridge.enabled) await onToggleEnabled();
    } catch (e) {
      alert(`Re-pair failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairing(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <button onClick={onBack} className="p-1 rounded hover:bg-surface-3 text-zinc-400">
          <ArrowLeft size={14} />
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="flex-1 bg-transparent text-sm font-semibold text-zinc-100 outline-none border-b border-transparent focus:border-accent"
          disabled={savingName}
        />
        <StatusPill status={live?.status ?? bridge.status} />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <section className="rounded-lg border border-border bg-surface-2 p-3 space-y-3">
          <header className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Connection</h3>
            <span className="text-[11px] text-zinc-500 ml-auto">
              {live?.paired_id ?? bridge.paired_id ?? "Not paired"}
            </span>
          </header>

          {(live?.status === "pairing" || (!live && bridge.status === "pairing")) && live?.qr_data_url && (
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="bg-white p-3 rounded-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={live.qr_data_url} alt="WhatsApp pairing QR" className="w-48 h-48 block" />
              </div>
              <p className="text-[11px] text-zinc-500 text-center max-w-xs">
                Open WhatsApp on your phone → Settings → Linked Devices → Link a device → scan this code.
              </p>
            </div>
          )}

          {(live?.last_error || bridge.last_error) && (
            <p className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1">
              {live?.last_error ?? bridge.last_error}
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={bridge.enabled}
                onChange={() => void onToggleEnabled()}
                className="accent-accent"
              />
              Enabled
            </label>
            <button
              onClick={rePair}
              disabled={repairing}
              className="ml-auto px-2 py-1 text-xs rounded bg-surface-3 hover:bg-surface-3/70 text-zinc-300 flex items-center gap-1 disabled:opacity-50"
            >
              {repairing ? <RefreshCw size={11} className="animate-spin" /> : <QrCode size={11} />}
              Re-pair
            </button>
          </div>
        </section>

        <RouteTable bridge_id={bridge.id} />

        <section className="rounded-lg border border-border bg-surface-2 p-3 text-[11px] text-zinc-500 leading-relaxed">
          <p>
            <strong className="text-zinc-300">Unrouted messages are ignored.</strong>{" "}
            If a WhatsApp chat isn&apos;t mapped to an agent below, incoming messages are silently dropped
            (you&apos;ll still see a hint in notifications so you can add a route). Each agent can serve
            only one chat — they keep a single conversation thread.
          </p>
        </section>
      </div>
    </div>
  );
}

function RouteTable({ bridge_id }: { bridge_id: string }) {
  const { routes, create, update, remove } = useBridgeRoutes(bridge_id);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ remote_jid: string; agent_id: string; label: string }>({
    remote_jid: "", agent_id: "", label: "",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.agents.list().then(setAgents).catch(() => {}); }, []);

  // Agents already targeted by other routes are unavailable in the picker.
  const usedAgents = new Set(routes.map((r) => r.agent_id));
  const availableAgents = agents.filter((a) => !usedAgents.has(a.id));

  async function onAdd() {
    setError(null);
    const remote_jid = draft.remote_jid.trim();
    const agent_id = draft.agent_id.trim();
    if (!remote_jid || !agent_id) { setError("JID and agent are required"); return; }
    try {
      await create({ remote_jid, agent_id, label: draft.label.trim() || null });
      setAdding(false);
      setDraft({ remote_jid: "", agent_id: "", label: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-2 p-3 space-y-2">
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Routes</h3>
        <span className="text-[11px] text-zinc-500">{routes.length}</span>
        <button
          onClick={() => { setAdding(true); setError(null); }}
          className="ml-auto px-2 py-0.5 text-[11px] rounded bg-accent/15 hover:bg-accent/25 text-accent flex items-center gap-1"
        >
          <Plus size={10} /> Add
        </button>
      </header>

      {adding && (
        <div className="rounded border border-accent/30 bg-surface-3/30 p-2 space-y-2">
          <div className="grid grid-cols-1 gap-2">
            <input
              autoFocus
              value={draft.remote_jid}
              onChange={(e) => setDraft((d) => ({ ...d, remote_jid: e.target.value }))}
              placeholder="WhatsApp JID — 5511999990000@s.whatsapp.net or <id>@g.us"
              className="px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none font-mono"
            />
            <select
              value={draft.agent_id}
              onChange={(e) => setDraft((d) => ({ ...d, agent_id: e.target.value }))}
              className="px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none"
            >
              <option value="">Select agent…</option>
              {availableAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="Label (optional, e.g. Mom, Support Group)"
              className="px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none"
            />
          </div>
          {error && <p className="text-[11px] text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <button onClick={onAdd} className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent/90">
              Add route
            </button>
            <button onClick={() => { setAdding(false); setError(null); }} className="px-3 py-1 text-xs rounded text-zinc-400 hover:bg-surface-3">
              Cancel
            </button>
          </div>
        </div>
      )}

      {routes.length === 0 && !adding && (
        <p className="text-[11px] text-zinc-500 py-2">No routes. Inbound messages will be ignored.</p>
      )}

      {routes.map((r) => (
        <RouteRow
          key={r.id}
          route={r}
          agent={agents.find((a) => a.id === r.agent_id) ?? null}
          onChangeAgent={async (agent_id) => {
            try { await update(r.id, { agent_id }); }
            catch (e) { alert(e instanceof Error ? e.message : String(e)); }
          }}
          agents={agents.filter((a) => a.id === r.agent_id || !usedAgents.has(a.id))}
          onDelete={async () => {
            if (!confirm("Delete this route? Incoming messages from this chat will be ignored.")) return;
            await remove(r.id);
          }}
        />
      ))}
    </section>
  );
}

function RouteRow({
  route, agent, agents, onChangeAgent, onDelete,
}: {
  route: BridgeRoute;
  agent: AgentConfig | null;
  agents: AgentConfig[];
  onChangeAgent: (id: string) => Promise<void>;
  onDelete: () => Promise<void> | void;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-t border-border first:border-t-0">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-zinc-300 truncate">{route.remote_jid}</p>
        {route.label && <p className="text-[10px] text-zinc-500 truncate">{route.label}</p>}
      </div>
      <select
        value={agent?.id ?? ""}
        onChange={(e) => void onChangeAgent(e.target.value)}
        className="px-1.5 py-0.5 text-[11px] bg-surface-3 rounded border border-border focus:border-accent outline-none max-w-[40%]"
      >
        {!agent && <option value="">(missing agent)</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <button
        onClick={() => void onDelete()}
        className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-surface-3"
        title="Delete route"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
