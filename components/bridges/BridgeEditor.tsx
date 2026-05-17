"use client";
import { ArrowLeft, Plus, QrCode, RefreshCw, Search, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Bridge, BridgeChat, BridgeLiveStatus, BridgeRoute } from "@/api/types";
import { useBridgeRoutes } from "@/hooks/useBridges";
import { StatusPill } from "./BridgesPanel";

/**
 * Single-bridge editor: shows live status (QR while pairing, paired ID once
 * connected), exposes the re-pair button, and embeds the routing table that
 * binds WhatsApp chats (JIDs) to agents.
 *
 * Routes have a `UNIQUE(agent_id)` constraint server-side — each agent is
 * the target of at most one route across all bridges. The single-thread-per-
 * agent invariant carries over from the rest of Jarela: the bridge enqueues
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
  const [chats, setChats] = useState<BridgeChat[]>([]);
  const [chatsRunning, setChatsRunning] = useState<boolean>(true);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ remote_jid: string; agent_id: string; label: string }>({
    remote_jid: "", agent_id: "", label: "",
  });
  const [error, setError] = useState<string | null>(null);

  // Inline lookup state — phone number → WhatsApp JID via /lookup.
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  // Locally-resolved chats (from phone lookups) merged into the picker
  // alongside the synced list. Keeps a hit visible even if the bridge's
  // chat cache drops it later.
  const [extraChats, setExtraChats] = useState<BridgeChat[]>([]);

  useEffect(() => { api.agents.list().then(setAgents).catch(() => {}); }, []);

  // Pull chats whenever the Add form opens, then keep polling every 4s
  // while it stays open so newly-arrived chats appear without the user
  // needing to close+reopen the dialog. Re-pair / first-time pair often
  // takes several seconds before history-sync delivers the chat list.
  useEffect(() => {
    if (!adding) return;
    let alive = true;
    async function load() {
      setChatsLoading(true);
      try {
        const r = await api.bridges.chats(bridge_id);
        if (!alive) return;
        setChats(r.chats);
        setChatsRunning(r.running);
      } catch { /* ignore — UI shows empty state */ }
      finally { if (alive) setChatsLoading(false); }
    }
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => { alive = false; clearInterval(t); };
  }, [adding, bridge_id]);

  // Agents already targeted by other routes are unavailable in the picker.
  const usedAgents = new Set(routes.map((r) => r.agent_id));
  const availableAgents = agents.filter((a) => !usedAgents.has(a.id));

  // Hide chats that already have a route — picking them would just throw
  // a UNIQUE violation. Sort: groups & named chats first, then the rest.
  const routedJids = new Set(routes.map((r) => r.remote_jid));
  const availableChats = useMemo(() => {
    // Merge synced chats with locally-resolved phone-lookup hits; the
    // synced entry wins on collision (it has the better metadata).
    const byJid = new Map<string, BridgeChat>();
    for (const c of extraChats) byJid.set(c.remote_jid, c);
    for (const c of chats) byJid.set(c.remote_jid, c);
    return Array.from(byJid.values()).filter((c) => !routedJids.has(c.remote_jid));
  }, [chats, extraChats, routedJids]);

  function selectChat(jid: string) {
    const c = availableChats.find((x) => x.remote_jid === jid);
    setDraft((d) => ({
      remote_jid: jid,
      agent_id: d.agent_id,
      // Auto-fill the label from the chat name when the user hasn't typed
      // anything yet — saves typing on the common case.
      label: d.label.trim() ? d.label : (c?.name ?? d.label),
    }));
  }

  async function onSearch() {
    setSearchMsg(null);
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await api.bridges.lookup(bridge_id, q);
      if (!r.chat) {
        setSearchMsg("That number isn't on WhatsApp.");
        return;
      }
      if (routedJids.has(r.chat.remote_jid)) {
        setSearchMsg("That chat already has a route.");
        return;
      }
      // Merge into the picker and auto-select. setExtraChats is async, so
      // we don't rely on availableChats for the selection — set draft
      // directly from the hit.
      setExtraChats((prev) => {
        const exists = prev.some((c) => c.remote_jid === r.chat!.remote_jid);
        return exists ? prev : [...prev, r.chat!];
      });
      setDraft((d) => ({
        remote_jid: r.chat!.remote_jid,
        agent_id: d.agent_id,
        label: d.label.trim() ? d.label : (r.chat!.name ?? d.label),
      }));
      setSearchQuery("");
    } catch (e) {
      setSearchMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function onAdd() {
    setError(null);
    const remote_jid = draft.remote_jid.trim();
    const agent_id = draft.agent_id.trim();
    if (!remote_jid || !agent_id) { setError("Pick a chat and an agent"); return; }
    try {
      await create({ remote_jid, agent_id, label: draft.label.trim() || null });
      setAdding(false);
      setManualMode(false);
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
          {!manualMode ? (
            <>
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Chat</label>
                {chatsLoading && <RefreshCw size={10} className="animate-spin text-zinc-500" />}
                <button
                  type="button"
                  onClick={() => setManualMode(true)}
                  className="ml-auto text-[10px] text-zinc-500 hover:text-accent underline-offset-2 hover:underline"
                >
                  Enter JID manually
                </button>
              </div>
              {!chatsRunning && (
                <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                  Bridge isn&apos;t running — enable it to load your WhatsApp chats.
                </p>
              )}
              {chatsRunning && (
                <>
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 flex items-center gap-1.5 rounded border border-border bg-surface-3/60 px-2 py-1 focus-within:border-accent/60">
                      <Search size={11} className="text-zinc-500 shrink-0" />
                      <input
                        type="tel"
                        inputMode="tel"
                        placeholder="Find by phone (e.g. +1 555 123 4567)"
                        value={searchQuery}
                        onChange={(e) => { setSearchQuery(e.target.value); setSearchMsg(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void onSearch(); } }}
                        className="flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-600"
                        disabled={searching}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void onSearch()}
                      disabled={searching || !searchQuery.trim()}
                      className="text-[11px] px-2 py-1 rounded border border-border bg-surface-3 hover:bg-surface-2 disabled:opacity-40"
                    >
                      {searching ? "…" : "Find"}
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-snug">
                    WhatsApp only auto-syncs your recent chats. Use search to find any contact (including
                    yourself) by phone number — country code + digits, no spaces required.
                  </p>
                  {searchMsg && (
                    <p className="text-[11px] text-amber-300">{searchMsg}</p>
                  )}
                </>
              )}
              {chatsRunning && availableChats.length === 0 && !chatsLoading && (
                <p className="text-[11px] text-zinc-500 px-1 py-2 leading-relaxed">
                  No chats synced yet. WhatsApp delivers your chat list a few seconds after pairing, and any
                  chat you receive a message in will also appear here. If you can&apos;t wait, you can{" "}
                  <button
                    type="button"
                    onClick={() => setManualMode(true)}
                    className="text-accent hover:underline"
                  >
                    enter the JID manually
                  </button>.
                </p>
              )}
              {availableChats.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded border border-border bg-surface-3/40 divide-y divide-border">
                  {availableChats.map((c) => (
                    <button
                      key={c.remote_jid}
                      type="button"
                      onClick={() => selectChat(c.remote_jid)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
                        draft.remote_jid === c.remote_jid
                          ? "bg-accent/20 text-zinc-100"
                          : "hover:bg-surface-3 text-zinc-200"
                      }`}
                    >
                      <span className={`w-5 h-5 rounded shrink-0 flex items-center justify-center ${
                        c.is_group ? "bg-violet-500/20 text-violet-300" : "bg-emerald-500/20 text-emerald-300"
                      }`}>
                        {c.is_group ? <Users size={10} /> : <span className="text-[10px] font-bold">{(c.name ?? "?").charAt(0).toUpperCase()}</span>}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{c.name ?? <span className="text-zinc-500 italic">Unnamed</span>}</div>
                        <div className="text-[10px] text-zinc-500 truncate font-mono">{c.remote_jid}</div>
                      </div>
                      {c.last_message_at && (
                        <span className="text-[9px] text-zinc-500 shrink-0">{formatRelative(c.last_message_at)}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">JID</label>
                <button
                  type="button"
                  onClick={() => setManualMode(false)}
                  className="ml-auto text-[10px] text-zinc-500 hover:text-accent underline-offset-2 hover:underline"
                >
                  Pick from chat list
                </button>
              </div>
              <input
                autoFocus
                value={draft.remote_jid}
                onChange={(e) => setDraft((d) => ({ ...d, remote_jid: e.target.value }))}
                placeholder="5511999990000@s.whatsapp.net or <group-id>@g.us"
                className="w-full px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none font-mono"
              />
            </>
          )}

          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Agent</label>
            <select
              value={draft.agent_id}
              onChange={(e) => setDraft((d) => ({ ...d, agent_id: e.target.value }))}
              className="w-full px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none"
            >
              <option value="">Select agent…</option>
              {availableAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>

            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Label (optional)</label>
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="e.g. Mom, Support Group"
              className="w-full px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none"
            />
          </div>

          {error && <p className="text-[11px] text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={onAdd}
              disabled={!draft.remote_jid || !draft.agent_id}
              className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add route
            </button>
            <button
              onClick={() => { setAdding(false); setManualMode(false); setError(null); setDraft({ remote_jid: "", agent_id: "", label: "" }); }}
              className="px-3 py-1 text-xs rounded text-zinc-400 hover:bg-surface-3"
            >
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
          chatName={chats.find((c) => c.remote_jid === r.remote_jid)?.name ?? null}
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
  route, chatName, agent, agents, onChangeAgent, onDelete,
}: {
  route: BridgeRoute;
  chatName: string | null;
  agent: AgentConfig | null;
  agents: AgentConfig[];
  onChangeAgent: (id: string) => Promise<void>;
  onDelete: () => Promise<void> | void;
}) {
  // Prefer the route's user-set label, fall back to the live chat name from
  // the picker, then the JID itself. Always show the JID as the small
  // monospaced subline so the user can verify the binding.
  const headline = route.label?.trim() || chatName || route.remote_jid;
  const showJidSubline = headline !== route.remote_jid;
  return (
    <div className="flex items-center gap-2 py-1.5 border-t border-border first:border-t-0">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-200 truncate">{headline}</p>
        {showJidSubline && (
          <p className="text-[10px] font-mono text-zinc-500 truncate">{route.remote_jid}</p>
        )}
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

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString();
}
