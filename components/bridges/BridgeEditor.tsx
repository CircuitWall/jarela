"use client";
import { ArrowLeft, Camera, Plus, QrCode, RefreshCw, Search, Trash2, Users, VolumeX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Bridge, BridgeChat, BridgeLiveStatus, BridgeModuleInfo, BridgeRoute, ModelConfig } from "@/api/types";
import { useBridgeIgnores, useBridgeRoutes } from "@/hooks/useBridges";
import { modelSupportsImages, isProviderClassified } from "@/lib/providers/capabilities";
import { resolveAgentModel } from "@/lib/agents/effective-model";
import { formatRelativeOrDate } from "@/lib/utils/time";
import { pushErrorToast } from "@/lib/ui/error-report";
import { StatusPill } from "./BridgesPanel";
import { errorMessage } from "@/lib/utils/error";

import { confirmAction } from "@/lib/ui/confirm";

/**
 * Single-bridge editor: shows connection status and module-declared controls,
 * then routes remote chat identifiers to agents.
 *
 * Routes have a `UNIQUE(agent_id)` constraint server-side — each agent is
 * the target of at most one route across all bridges. A route can be a
 * specific remote chat ID or `*` (catch-all for otherwise-unrouted chats). In both
 * cases inbound text is enqueued into that agent's existing thread.
 */
export function BridgeEditor({
  bridge, module, onBack, onRename, onToggleEnabled, onPatch,
}: {
  bridge: Bridge;
  module: BridgeModuleInfo;
  onBack: () => void;
  onRename: (name: string) => Promise<unknown>;
  onToggleEnabled: () => Promise<unknown> | unknown;
  onPatch: (patch: import("@/api/types").BridgePatch) => Promise<unknown>;
}) {
  const [name, setName] = useState(bridge.name);
  const [savingName, setSavingName] = useState(false);
  const [live, setLive] = useState<BridgeLiveStatus | null>(null);

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

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <button onClick={onBack} className="p-1 rounded hover:bg-surface-3 text-fg-subtle">
          <ArrowLeft size={14} />
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="flex-1 bg-transparent text-sm font-semibold text-fg outline-none border-b border-transparent focus:border-accent"
          disabled={savingName}
        />
        <StatusPill status={live?.status ?? bridge.status} />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <BridgeConnection live={live} bridge={bridge} module={module} onToggleEnabled={onToggleEnabled} />

        {module.groupEventSubscriptions && <BridgeEventSubscriptions bridge={bridge} onPatch={onPatch} />}

        <RouteTable bridge_id={bridge.id} module={module} />

        <IgnoreList bridge_id={bridge.id} module={module} />

        <section className="rounded-lg border border-border bg-surface-2 p-3 text-[11px] text-fg-faint leading-relaxed space-y-2">
          <p>
            <strong className="text-fg-muted">Unrouted messages are ignored (unless catch-all exists).</strong>{" "}
            If a {module.label} chat isn&apos;t mapped to an agent below, incoming messages are silently dropped
            unless you add a <em>catch-all</em> route (`*`). Each agent can still have only one route,
            but a catch-all route can intentionally aggregate many chats into one agent thread.
          </p>
          <p>
            <strong className="text-fg-muted">Carve chats out of the catch-all.</strong>{" "}
            Add specific chats to the <em>Ignored chats</em> list above to drop them <em>before</em> any
            agent runs — no thread history, no memory writes, no tools. Different from{" "}
            <em>Silent mode</em> on a route (agent still sees the messages, just doesn&apos;t reply).
          </p>
          <p>
            <strong className="text-fg-muted">What gets forwarded.</strong>{" "}
            {module.attachmentDescription ?? "Messages from this channel are forwarded as text."}
            {module.attachmentDescription?.includes("image") && <> The <Camera className="inline -mt-0.5" size={11} /> badge marks agents whose model can read images.</>}
          </p>
        </section>
      </div>
    </div>
  );
}

function RouteTable({ bridge_id, module }: { bridge_id: string; module: BridgeModuleInfo }) {
  const {
    routes,
    setAdding,
    setError,
    adding,
    creatingCatchAll,
    setDraft,
    setManualMode,
    hasCatchAll,
    manualMode,
    chatsLoading,
    chatsRunning,
    searchQuery,
    setSearchQuery,
    setSearchMsg,
    onSearch,
    searching,
    searchMsg,
    availableChats,
    selectChat,
    draft,
    availableAgents,
    agentVisionState,
    error,
    onAdd,
    agents,
    chats,
    update,
    usedAgents,
    remove,
  } = useBridgeRouteDraft({ bridge_id, module });

  return (
    <section className="rounded-lg border border-border bg-surface-2 p-3 space-y-2">
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Routes</h3>
        <span className="text-[11px] text-fg-faint">{routes.length}</span>
        <button
          onClick={() => { setAdding(true); setError(null); }}
          className="ml-auto px-2 py-0.5 text-[11px] rounded bg-accent/15 hover:bg-accent/25 text-accent flex items-center gap-1"
        >
          <Plus size={10} /> Add
        </button>
      </header>

      {adding && (
        <RouteAddForm
          creatingCatchAll={creatingCatchAll}
          setDraft={setDraft}
          setManualMode={setManualMode}
          setError={setError}
          hasCatchAll={hasCatchAll}
          module={module}
          manualMode={manualMode}
          chatsLoading={chatsLoading}
          chatsRunning={chatsRunning}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          setSearchMsg={setSearchMsg}
          onSearch={onSearch}
          searching={searching}
          searchMsg={searchMsg}
          availableChats={availableChats}
          selectChat={selectChat}
          draft={draft}
          availableAgents={availableAgents}
          agentVisionState={agentVisionState}
          error={error}
          onAdd={onAdd}
          setAdding={setAdding}
        />
      )}

      {routes.length === 0 && !adding && (
        <p className="text-[11px] text-fg-faint py-2">No routes. Inbound messages will be ignored unless you add a catch-all route.</p>
      )}

      {routes.length > 0 && (
        <p className="text-[10px] text-fg-faint pb-1">
          Route settings: pick which agent receives this chat, choose whether replies are
          sent back to chat (Silent mode off) or kept user-side only (Silent mode on), and
          select who should trigger outbound replies when not silent.
        </p>
      )}

      {routes.map((r) => {
        const a = agents.find((x) => x.id === r.agent_id) ?? null;
        return (
          <RouteRow
            key={r.id}
            route={r}
            chatName={chats.find((c) => c.remote_jid === r.remote_jid)?.name ?? null}
            agent={a}
            agentVision={a ? agentVisionState(a) : null}
            onChangeAgent={async (agent_id) => {
              try { await update(r.id, { agent_id }); }
              catch (e) {
                pushErrorToast({
                  title: "Couldn't change route's agent",
                  error: e,
                  context: { panel: "bridges", action: "route.changeAgent", route_id: r.id, agent_id },
                });
              }
            }}
            onToggleSilent={async (silent_mode) => {
              try { await update(r.id, { silent_mode }); }
              catch (e) {
                pushErrorToast({
                  title: "Couldn't toggle silent mode",
                  error: e,
                  context: { panel: "bridges", action: "route.toggleSilent", route_id: r.id, silent_mode },
                });
              }
            }}
            onChangeRespondTo={async (respond_to) => {
              try { await update(r.id, { respond_to }); }
              catch (e) {
                pushErrorToast({
                  title: "Couldn't change reply trigger",
                  error: e,
                  context: { panel: "bridges", action: "route.changeRespondTo", route_id: r.id, respond_to },
                });
              }
            }}
            agents={agents.filter((x) => x.id === r.agent_id || !usedAgents.has(x.id))}
            visionForAgent={(x) => agentVisionState(x)}
            onDelete={async () => {
              if (!(await confirmAction({ message: "Delete this route? Incoming messages from this chat will be ignored.", destructive: true }))) return;
              await remove(r.id);
            }}
          />
        );
      })}
    </section>
  );
}

function RouteRow({
  route, chatName, agent, agentVision, agents, visionForAgent, onChangeAgent, onToggleSilent, onChangeRespondTo, onDelete,
}: {
  route: BridgeRoute;
  chatName: string | null;
  agent: AgentConfig | null;
  agentVision: { supported: boolean; classified: boolean; modelLabel: string | null } | null;
  agents: AgentConfig[];
  visionForAgent: (a: AgentConfig) => { supported: boolean; classified: boolean; modelLabel: string | null };
  onChangeAgent: (id: string) => Promise<void>;
  onToggleSilent: (silent: boolean) => Promise<void>;
  onChangeRespondTo: (respond_to: "user" | "counterpart") => Promise<void>;
  onDelete: () => Promise<void> | void;
}) {
  // Prefer the route's user-set label, then the live chat name, then the
  // module's opaque remote identifier.
  const headline = route.label?.trim() || chatName || route.remote_jid;
  const isCatchAll = route.remote_jid === "*";
  const showRemoteIdSubline = headline !== route.remote_jid;
  return (
    <div className="py-1.5 border-t border-border first:border-t-0">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-fg truncate">
            {isCatchAll ? "Catch-all (everything else)" : headline}
          </p>
          {showRemoteIdSubline && (
            <p className="text-[10px] font-mono text-fg-faint truncate">{route.remote_jid}</p>
          )}
          {isCatchAll && (
            <p className="text-[10px] text-fg-faint">Matches any chat without an explicit route.</p>
          )}
        </div>
        <select
          value={agent?.id ?? ""}
          onChange={(e) => void onChangeAgent(e.target.value)}
          className="px-1.5 py-0.5 text-[11px] bg-surface-3 rounded border border-border focus:border-accent outline-none max-w-[40%]"
        >
          {!agent && <option value="">(missing agent)</option>}
          {agents.map((a) => {
            const v = visionForAgent(a);
            const prefix = v.supported ? "📷 " : "";
            return <option key={a.id} value={a.id}>{prefix}{a.name}</option>;
          })}
        </select>
        {agentVision && (
          <span
            title={
              agentVision.supported
                ? `Vision-capable model (${agentVision.modelLabel}) — reads images & stickers.`
                : agentVision.classified
                ? `Model ${agentVision.modelLabel ?? ""} doesn't accept images. Captions still reach the agent; the image itself is ignored.`
                : `Unknown capabilities for ${agentVision.modelLabel ?? "this model"} — image handling depends on the upstream provider.`
            }
            className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded ${
              agentVision.supported
                ? "text-emerald-600 dark:text-emerald-400"
                : agentVision.classified
                ? "text-amber-600 dark:text-amber-400"
                : "text-fg-faint"
            }`}
          >
            <Camera size={11} />
          </span>
        )}
        <button
          onClick={() => void onDelete()}
          className="p-1 rounded text-fg-faint hover:text-rose-700 dark:hover:text-rose-400 hover:bg-surface-3"
          title="Delete route"
        >
          <Trash2 size={11} />
        </button>
      </div>
      <label className="mt-1 flex items-start gap-2 cursor-pointer select-none px-0.5">
        <input
          type="checkbox"
          className="mt-0.5 rounded border-border"
          checked={route.silent_mode}
          onChange={(e) => void onToggleSilent(e.target.checked)}
        />
        <span className="text-[11px] text-fg-subtle leading-snug">
          <span className="text-fg-muted font-medium">Silent mode</span> — listen only, never auto-reply.
          <span className="block text-[10px] text-fg-faint">
            The agent still receives every message and can run tools / update memory, but nothing is sent back to the channel. Overrides the reply-trigger below.
          </span>
        </span>
      </label>
      <div className={`mt-1 flex items-start gap-2 px-0.5 ${route.silent_mode ? "opacity-50" : ""}`}>
        <span className="text-[11px] text-fg-subtle leading-snug flex-1">
          <span className="text-fg-muted font-medium">Reply trigger</span> — auto-reply when…
          <span className="block text-[10px] text-fg-faint">
            {route.respond_to === "counterpart"
              ? "Another participant sends a message. The agent stays quiet on your own messages."
              : "You send a message yourself (e.g. expand-my-draft assistant). The agent stays quiet on others'."}
          </span>
        </span>
        <select
          value={route.respond_to}
          disabled={route.silent_mode}
          onChange={(e) => void onChangeRespondTo(e.target.value as "user" | "counterpart")}
          className="px-1.5 py-0.5 text-[11px] bg-surface-3 rounded border border-border focus:border-accent outline-none disabled:cursor-not-allowed"
        >
          <option value="counterpart">Other participants</option>
          <option value="user">Me</option>
        </select>
      </div>
    </div>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff > 7 * 86_400_000) return new Date(ms).toLocaleDateString();
  return formatRelativeOrDate(ms).replace(/\sago$/, "");
}

/**
 * Per-bridge chat blocklist. When a catch-all route routes "everything
 * else" to a listener agent, this list carves out the chats that should
 * NEVER reach that agent — the router short-circuits to null for any
 * entry here, before any route lookup. Independent of routes: an ignore
 * entry can coexist with an explicit route (the ignore always wins), so
 * temporarily muting a routed chat doesn't require deleting the route.
 */
function IgnoreList({ bridge_id, module }: { bridge_id: string; module: BridgeModuleInfo }) {
  const { ignores, add, remove } = useBridgeIgnores(bridge_id);
  const [adding, setAdding] = useState(false);
  const { chats, chatsRunning, chatsLoading } = useBridgeChatDirectory(bridge_id, adding && Boolean(module.chatDirectory));
  const [manualJid, setManualJid] = useState("");
  const [pickerJid, setPickerJid] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ignoredJids = useMemo(() => new Set(ignores.map((i) => i.remote_jid)), [ignores]);
  const availableChats = useMemo(
    () => chats.filter((c) => !ignoredJids.has(c.remote_jid)),
    [chats, ignoredJids],
  );

  async function onAdd(remote_jid: string, label: string | null) {
    setError(null);
    const jid = remote_jid.trim();
    if (!jid) { setError(`Enter a ${module.remoteIdLabel}`); return; }
    try {
      await add({ remote_jid: jid, label });
      setManualJid("");
      setPickerJid("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function onRemove(remote_jid: string) {
    try { await remove(remote_jid); }
    catch (e) {
      pushErrorToast({
        title: "Couldn't remove ignore entry",
        error: e,
        context: { panel: "bridges", action: "ignore.remove", bridge_id, remote_jid },
      });
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-2 p-3 space-y-2">
      <header className="flex items-center gap-2">
        <VolumeX size={12} className="text-fg-subtle" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Ignored chats</h3>
        <span className="text-[11px] text-fg-faint">{ignores.length}</span>
        <button
          onClick={() => { setAdding((v) => !v); setError(null); }}
          className="ml-auto px-2 py-0.5 text-[11px] rounded bg-surface-3 hover:bg-surface-2 text-fg-muted flex items-center gap-1"
        >
          <Plus size={10} /> {adding ? "Close" : "Add"}
        </button>
      </header>

      <p className="text-[11px] text-fg-faint leading-snug">
        Chats on this list are dropped <em>before</em> any route runs — the agent never sees them, no
        memory is written, no tools fire. Useful when a catch-all route forwards everything and you
        want to carve out specific chats (family, personal DMs, noisy groups). To just suppress
        replies while still capturing history, use <strong>Silent mode</strong> on a normal route instead.
      </p>

      {adding && (
        <IgnoreChatForm
          module={module}
          chatsLoading={chatsLoading}
          chatsRunning={chatsRunning}
          availableChats={availableChats}
          setPickerJid={setPickerJid}
          onAdd={onAdd}
          pickerJid={pickerJid}
          manualJid={manualJid}
          setManualJid={setManualJid}
          error={error}
        />
      )}

      {ignores.length === 0 && !adding && (
        <p className="text-[11px] text-fg-faint py-1">
          No chats ignored. Add one to exclude it from catch-all routing without affecting other chats.
        </p>
      )}

      {ignores.map((i) => (
        <div key={i.id} className="py-1.5 border-t border-border first:border-t-0 flex items-center gap-2">
          <VolumeX size={11} className="text-fg-faint shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-fg truncate">{i.label ?? i.remote_jid}</p>
            {i.label && <p className="text-[10px] font-mono text-fg-faint truncate">{i.remote_jid}</p>}
          </div>
          <button
            onClick={() => void onRemove(i.remote_jid)}
            className="p-1 rounded text-fg-faint hover:text-rose-700 dark:hover:text-rose-400 hover:bg-surface-3"
            title="Remove from ignore list (resume forwarding)"
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
    </section>
  );
}

function BridgeConnection({ live, bridge, module, onToggleEnabled }: {
  live: BridgeLiveStatus | null;
  bridge: Bridge;
  module: BridgeModuleInfo;
  onToggleEnabled: () => Promise<unknown> | unknown;
}) {
  const [repairing, setRepairing] = useState(false);

  async function rePair() {
    if (!module.pairing) return;
    if (!(await confirmAction({ message: module.pairing.confirmMessage, destructive: true, confirmLabel: module.pairing.actionLabel }))) return;
    setRepairing(true);
    try {
      await api.bridges.pair(bridge.id);
      // Re-pairing also enables the bridge if it was off, so the QR fires.
      if (!bridge.enabled) await onToggleEnabled();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't re-pair bridge",
        error: e,
        context: { panel: "bridges", action: "bridge.rePair", bridge_id: bridge.id },
      });
    } finally {
      setRepairing(false);
    }
  }
  return (
    <section className="rounded-lg border border-border bg-surface-2 p-3 space-y-3">
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Connection</h3>
        <span className="text-[11px] text-fg-faint ml-auto">
          {live?.paired_id ?? bridge.paired_id ?? "Not paired"}
        </span>
      </header>

      {module.pairing && (live?.status === "pairing" || (!live && bridge.status === "pairing")) && live?.qr_data_url && (
        <div className="flex flex-col items-center gap-2 py-2">
          <div className="bg-white p-3 rounded-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={live.qr_data_url} alt={module.pairing.qrAlt} className="w-48 h-48 block" />
          </div>
          <p className="text-[11px] text-fg-faint text-center max-w-xs">
            {module.pairing.qrInstructions}
          </p>
        </div>
      )}

      {(live?.last_error || bridge.last_error) && (
        <p className="text-[11px] text-rose-700 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1">
          {live?.last_error ?? bridge.last_error}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={bridge.enabled}
            onChange={() => void onToggleEnabled()}
            className="accent-accent"
          />
          Enabled
        </label>
        {module.pairing && <button
          onClick={rePair}
          disabled={repairing}
          className="ml-auto px-2 py-1 text-xs rounded bg-surface-3 hover:bg-surface-3/70 text-fg-muted flex items-center gap-1 disabled:opacity-50"
        >
          {repairing ? <RefreshCw size={11} className="animate-spin" /> : <QrCode size={11} />}
          {module.pairing.actionLabel}
        </button>}
      </div>
    </section>
  );
}

function BridgeEventSubscriptions({ bridge, onPatch }: {
  bridge: Bridge;
  onPatch: (patch: import("@/api/types").BridgePatch) => Promise<unknown>;
}) {
  const [savingSubscriptions, setSavingSubscriptions] = useState<null | "group_profile_updates" | "group_participants_updates">(null);

  async function toggleEventSubscription(
    key: "group_profile_updates" | "group_participants_updates",
    next: boolean,
  ) {
    setSavingSubscriptions(key);
    try {
      await onPatch({
        event_subscriptions: {
          [key]: next,
        },
      });
    } finally {
      setSavingSubscriptions(null);
    }
  }
  return (
    <section className="rounded-lg border border-border bg-surface-2 p-3 space-y-2">
    <header className="flex items-center gap-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Event forwarding</h3>
    </header>
    <p className="text-[11px] text-fg-faint leading-relaxed">
    Choose which group update types are forwarded to agents. Event payloads use the same
    unified bridge message envelope as chat messages, with explicit event metadata so agents can
    distinguish system updates from participant text.
    </p>
    <label className="flex items-start gap-2 cursor-pointer select-none px-0.5">
    <input
    type="checkbox"
    className="mt-0.5 rounded border-border"
    checked={bridge.event_subscriptions.group_profile_updates}
    disabled={savingSubscriptions !== null}
    onChange={(e) => void toggleEventSubscription("group_profile_updates", e.target.checked)}
    />
    <span className="text-[11px] text-fg-subtle leading-snug">
    <span className="text-fg-muted font-medium">Group profile/settings updates</span>
    <span className="block text-[10px] text-fg-faint">
    Subject, description, announce/restrict mode, and disappearing-message timer changes.
    </span>
    </span>
    </label>
    <label className="flex items-start gap-2 cursor-pointer select-none px-0.5">
    <input
    type="checkbox"
    className="mt-0.5 rounded border-border"
    checked={bridge.event_subscriptions.group_participants_updates}
    disabled={savingSubscriptions !== null}
    onChange={(e) => void toggleEventSubscription("group_participants_updates", e.target.checked)}
    />
    <span className="text-[11px] text-fg-subtle leading-snug">
    <span className="text-fg-muted font-medium">Group participant updates</span>
    <span className="block text-[10px] text-fg-faint">
    Member add/remove and admin promote/demote changes.
    </span>
    </span>
    </label>
    </section>
  );
}

function useBridgeChatDirectory(bridgeId: string, active: boolean) {
  const [chats, setChats] = useState<BridgeChat[]>([]);
  const [chatsRunning, setChatsRunning] = useState(true);
  const [chatsLoading, setChatsLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    async function load() {
      setChatsLoading(true);
      try {
        const result = await api.bridges.chats(bridgeId);
        if (!alive) return;
        setChats(result.chats);
        setChatsRunning(result.running);
      } catch { /* retain the empty state when the directory is unavailable */ }
      finally { if (alive) setChatsLoading(false); }
    }
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, bridgeId]);

  return { chats, chatsRunning, chatsLoading };
}

function RouteAgentFields({ draft, setDraft, availableAgents, agentVisionState, creatingCatchAll }: {
  draft: { remote_jid: string; agent_id: string; label: string; };
  setDraft: React.Dispatch<React.SetStateAction<{ remote_jid: string; agent_id: string; label: string; }>>;
  availableAgents: AgentConfig[];
  agentVisionState: (a: AgentConfig) => { supported: boolean; classified: boolean; modelLabel: string | null; };
  creatingCatchAll: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-[10px] uppercase tracking-wide text-fg-faint font-semibold">Agent</label>
      <select
        value={draft.agent_id}
        onChange={(e) => setDraft((d) => ({ ...d, agent_id: e.target.value }))}
        className="w-full px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none"
      >
        <option value="">Select agent…</option>
        {availableAgents.map((a) => {
          const v = agentVisionState(a);
          // Prefix the option label with a camera glyph for vision-
          // capable agents so the picker conveys the capability
          // without needing a separate column. Plain <option> can't
          // hold an SVG; the unicode camera is the closest stable
          // glyph that renders across OSes.
          const prefix = v.supported ? "📷 " : v.classified ? "   " : "   ";
          return (
            <option key={a.id} value={a.id}>{prefix}{a.name}</option>
          );
        })}
      </select>
      {(() => {
        const a = availableAgents.find((x) => x.id === draft.agent_id);
        if (!a) return null;
        const v = agentVisionState(a);
        if (v.supported) {
          return (
            <p className="text-[10px] text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
              <Camera size={10} /> Vision-capable — images forwarded by this bridge can be read by this agent.
            </p>
          );
        }
        if (!v.classified) {
          return (
            <p className="text-[10px] text-fg-faint">
              Unknown model capabilities ({v.modelLabel ?? "no model"}) — images will be forwarded; whether the model can interpret them depends on the upstream provider.
            </p>
          );
        }
        return (
          <p className="text-[10px] text-amber-700 dark:text-amber-300">
            This agent&apos;s model ({v.modelLabel ?? "none"}) doesn&apos;t accept images. Text and image <em>captions</em> still reach it, but the image itself will be ignored. Switch the agent&apos;s model to a vision-capable one (e.g. gpt-4o, claude-3.5/4, gemini-1.5+) to enable image understanding.
          </p>
        );
      })()}

      <label className="block text-[10px] uppercase tracking-wide text-fg-faint font-semibold">Label (optional)</label>
      <input
        value={draft.label}
        onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
        placeholder={creatingCatchAll ? "e.g. Catch-all triage" : "e.g. Mom, Support Group"}
        className="w-full px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none"
      />
    </div>
  );
}

function RouteChatPicker({
  chatsLoading,
  setManualMode,
  module,
  chatsRunning,
  searchQuery,
  setSearchQuery,
  setSearchMsg,
  onSearch,
  searching,
  searchMsg,
  availableChats,
  selectChat,
  draft,
}: {
  chatsLoading: boolean;
  setManualMode: React.Dispatch<React.SetStateAction<boolean>>;
  module: BridgeModuleInfo;
  chatsRunning: boolean;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSearchMsg: React.Dispatch<React.SetStateAction<string | null>>;
  onSearch: () => Promise<void>;
  searching: boolean;
  searchMsg: string | null;
  availableChats: BridgeChat[];
  selectChat: (jid: string) => void;
  draft: { remote_jid: string; agent_id: string; label: string; };
}) {
  return (
    <>
    <div className="flex items-center gap-2">
      <label className="text-[10px] uppercase tracking-wide text-fg-faint font-semibold">Chat</label>
      {chatsLoading && <RefreshCw size={10} className="animate-spin text-fg-faint" />}
      <button
        type="button"
        onClick={() => setManualMode(true)}
        className="ml-auto text-[10px] text-fg-faint hover:text-accent underline-offset-2 hover:underline"
      >
        Enter {module.remoteIdLabel} manually
      </button>
    </div>
    {!chatsRunning && (
      <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
        Bridge isn&apos;t running — enable it to load chats.
      </p>
    )}
    {chatsRunning && (
      <>
        {module.chatLookup && <div className="flex items-center gap-1.5">
          <div className="flex-1 flex items-center gap-1.5 rounded border border-border bg-surface-3/60 px-2 py-1 focus-within:border-accent/60">
            <Search size={11} className="text-fg-faint shrink-0" />
            <input
              type={module.chatLookup.inputType}
              inputMode={module.chatLookup.inputType === "tel" ? "tel" : undefined}
              placeholder={module.chatLookup.placeholder}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchMsg(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void onSearch(); } }}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-fg-faint"
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
        </div>}
        {module.chatLookup && <p className="text-[10px] text-fg-faint leading-snug">{module.chatLookup.description}</p>}
        {searchMsg && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300">{searchMsg}</p>
        )}
      </>
    )}
    {chatsRunning && availableChats.length === 0 && !chatsLoading && (
      <p className="text-[11px] text-fg-faint px-1 py-2 leading-relaxed">
        No chats synced yet. Recent chats appear after the bridge connects. If you can&apos;t wait, you can{" "}
        <button
          type="button"
          onClick={() => setManualMode(true)}
          className="text-accent hover:underline"
        >
          enter the {module.remoteIdLabel} manually
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
                ? "bg-accent/20 text-fg"
                : "hover:bg-surface-3 text-fg"
            }`}
          >
            <span className={`w-5 h-5 rounded shrink-0 flex items-center justify-center ${
              c.is_group ? "bg-violet-500/20 text-violet-700 dark:text-violet-300" : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            }`}>
              {c.is_group ? <Users size={10} /> : <span className="text-[10px] font-bold">{(c.name ?? "?").charAt(0).toUpperCase()}</span>}
            </span>
            <div className="flex-1 min-w-0">
              <div className="truncate">{c.name ?? <span className="text-fg-faint italic">Unnamed</span>}</div>
              <div className="text-[10px] text-fg-faint truncate font-mono">{c.remote_jid}</div>
            </div>
            {c.last_message_at && (
              <span className="text-[9px] text-fg-faint shrink-0">{formatRelative(c.last_message_at)}</span>
            )}
          </button>
        ))}
      </div>
    )}
    </>
  );
}

function useBridgeRouteDraft({ bridge_id, module }: { bridge_id: string; module: BridgeModuleInfo }) {
  const { routes, create, update, remove } = useBridgeRoutes(bridge_id);
  const { agents, agentVisionState } = useBridgeAgentModels();
  const [manualMode, setManualMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const { chats, chatsRunning, chatsLoading } = useBridgeChatDirectory(bridge_id, adding && Boolean(module.chatDirectory));
  const [draft, setDraft] = useState<{ remote_jid: string; agent_id: string; label: string }>({
    remote_jid: "", agent_id: "", label: "",
  });
  const [error, setError] = useState<string | null>(null);

  // Inline lookup state for modules that expose a remote-identity lookup.
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  // Locally-resolved chats (from phone lookups) merged into the picker
  // alongside the synced list. Keeps a hit visible even if the bridge's
  // chat cache drops it later.
  const [extraChats, setExtraChats] = useState<BridgeChat[]>([]);
  // Agents already targeted by other routes are unavailable in the picker.
  const usedAgents = new Set(routes.map((r) => r.agent_id));
  const availableAgents = agents.filter((a) => !usedAgents.has(a.id));
  const hasCatchAll = routes.some((r) => r.remote_jid === "*");
  const creatingCatchAll = draft.remote_jid === "*";

  // Hide chats that already have a route — picking them would just throw
  // a UNIQUE violation. Sort: groups & named chats first, then the rest.
  const routedJids = useMemo(
    () => new Set(routes.map((r) => r.remote_jid)),
    [routes],
  );
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
    const lookup = module.chatLookup;
    if (!lookup) return;
    setSearchMsg(null);
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await api.bridges.lookup(bridge_id, q);
      if (!r.chat) {
        setSearchMsg(lookup.notFoundMessage);
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
      setSearchMsg(errorMessage(e));
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
      setError(errorMessage(e));
    }
  }

  return {
    routes,
    setAdding,
    setError,
    adding,
    creatingCatchAll,
    setDraft,
    setManualMode,
    hasCatchAll,
    manualMode,
    chatsLoading,
    chatsRunning,
    searchQuery,
    setSearchQuery,
    setSearchMsg,
    onSearch,
    searching,
    searchMsg,
    availableChats,
    selectChat,
    draft,
    availableAgents,
    agentVisionState,
    error,
    onAdd,
    agents,
    chats,
    update,
    usedAgents,
    remove,
  };
}

function useBridgeAgentModels() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);

  useEffect(() => { api.agents.list().then(setAgents).catch(() => {}); }, []);
  useEffect(() => { api.models.list().then(setModels).catch(() => {}); }, []);

  function agentVisionState(agent: AgentConfig) {
    const config = resolveAgentModel(agent, models);
    if (!config) return { supported: false, classified: false, modelLabel: null };
    return {
      supported: config.capabilities?.vision ?? modelSupportsImages(config.provider, config.model_id),
      classified: isProviderClassified(config.provider),
      modelLabel: `${config.provider} / ${config.model_id}`,
    };
  }

  return { agents, agentVisionState };
}

function RouteAddForm({
  creatingCatchAll,
  setDraft,
  setManualMode,
  setError,
  hasCatchAll,
  module,
  manualMode,
  chatsLoading,
  chatsRunning,
  searchQuery,
  setSearchQuery,
  setSearchMsg,
  onSearch,
  searching,
  searchMsg,
  availableChats,
  selectChat,
  draft,
  availableAgents,
  agentVisionState,
  error,
  onAdd,
  setAdding,
}: {
  creatingCatchAll: boolean;
  setDraft: React.Dispatch<React.SetStateAction<{ remote_jid: string; agent_id: string; label: string; }>>;
  setManualMode: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  hasCatchAll: boolean;
  module: BridgeModuleInfo;
  manualMode: boolean;
  chatsLoading: boolean;
  chatsRunning: boolean;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSearchMsg: React.Dispatch<React.SetStateAction<string | null>>;
  onSearch: () => Promise<void>;
  searching: boolean;
  searchMsg: string | null;
  availableChats: BridgeChat[];
  selectChat: (jid: string) => void;
  draft: { remote_jid: string; agent_id: string; label: string; };
  availableAgents: AgentConfig[];
  agentVisionState: (a: AgentConfig) => { supported: boolean; classified: boolean; modelLabel: string | null; };
  error: string | null;
  onAdd: () => Promise<void>;
  setAdding: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="rounded border border-accent/30 bg-surface-3/30 p-2 space-y-2">
      <CatchAllRouteToggle
        creatingCatchAll={creatingCatchAll}
        setDraft={setDraft}
        setManualMode={setManualMode}
        setError={setError}
        hasCatchAll={hasCatchAll}
      />

      {creatingCatchAll && (
        <p className="text-[11px] text-fg-faint leading-snug">
          This route matches any inbound chat without an explicit route. The agent will receive
          chat metadata (name + remote ID) in each message so it can distinguish sources.
        </p>
      )}

      {!creatingCatchAll && (
        module.chatDirectory && !manualMode ? (
          <RouteChatPicker
            chatsLoading={chatsLoading}
            setManualMode={setManualMode}
            module={module}
            chatsRunning={chatsRunning}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            setSearchMsg={setSearchMsg}
            onSearch={onSearch}
            searching={searching}
            searchMsg={searchMsg}
            availableChats={availableChats}
            selectChat={selectChat}
            draft={draft}
          />
        ) : (
          <>
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wide text-fg-faint font-semibold">{module.remoteIdLabel}</label>
            {module.chatDirectory && <button
              type="button"
              onClick={() => setManualMode(false)}
              className="ml-auto text-[10px] text-fg-faint hover:text-accent underline-offset-2 hover:underline"
            >
              Pick from chat list
            </button>}
          </div>
          <input
            autoFocus
            value={draft.remote_jid}
            onChange={(e) => setDraft((d) => ({ ...d, remote_jid: e.target.value }))}
            placeholder={module.remoteIdPlaceholder}
            className="w-full px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none font-mono"
          />
          </>
        )
      )}

      <RouteAgentFields
        draft={draft}
        setDraft={setDraft}
        availableAgents={availableAgents}
        agentVisionState={agentVisionState}
        creatingCatchAll={creatingCatchAll}
      />

      {error && <p className="text-[11px] text-rose-700 dark:text-rose-300">{error}</p>}
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
          className="px-3 py-1 text-xs rounded text-fg-subtle hover:bg-surface-3"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function IgnoreChatForm({
  module,
  chatsLoading,
  chatsRunning,
  availableChats,
  setPickerJid,
  onAdd,
  pickerJid,
  manualJid,
  setManualJid,
  error,
}: {
  module: BridgeModuleInfo;
  chatsLoading: boolean;
  chatsRunning: boolean;
  availableChats: BridgeChat[];
  setPickerJid: React.Dispatch<React.SetStateAction<string>>;
  onAdd: (remote_jid: string, label: string | null) => Promise<void>;
  pickerJid: string;
  manualJid: string;
  setManualJid: React.Dispatch<React.SetStateAction<string>>;
  error: string | null;
}) {
  return (
    <div className="rounded border border-accent/30 bg-surface-3/30 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wide text-fg-faint font-semibold">{module.chatDirectory ? "Pick a chat" : module.remoteIdLabel}</label>
        {chatsLoading && <RefreshCw size={10} className="animate-spin text-fg-faint" />}
      </div>
      {module.chatDirectory && !chatsRunning && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
          Bridge isn&apos;t running — enable it to load chats, or enter an ID manually below.
        </p>
      )}
      {module.chatDirectory && chatsRunning && availableChats.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded border border-border bg-surface-3/40 divide-y divide-border">
          {availableChats.map((c) => (
            <button
              key={c.remote_jid}
              type="button"
              onClick={() => { setPickerJid(c.remote_jid); void onAdd(c.remote_jid, c.name ?? null); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
                pickerJid === c.remote_jid ? "bg-accent/20 text-fg" : "hover:bg-surface-3 text-fg"
              }`}
            >
              <span className={`w-5 h-5 rounded shrink-0 flex items-center justify-center ${
                c.is_group
                  ? "bg-violet-500/20 text-violet-700 dark:text-violet-300"
                  : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
              }`}>
                {c.is_group ? <Users size={10} /> : <span className="text-[10px] font-bold">{(c.name ?? "?").charAt(0).toUpperCase()}</span>}
              </span>
              <div className="flex-1 min-w-0">
                <div className="truncate">{c.name ?? <span className="text-fg-faint italic">Unnamed</span>}</div>
                <div className="text-[10px] text-fg-faint truncate font-mono">{c.remote_jid}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {module.chatDirectory && chatsRunning && availableChats.length === 0 && !chatsLoading && (
        <p className="text-[11px] text-fg-faint px-1 py-1 leading-relaxed">
          No unignored chats synced yet. Enter an ID manually below.
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={manualJid}
          onChange={(e) => setManualJid(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void onAdd(manualJid, null); } }}
          placeholder={module.remoteIdPlaceholder}
          className="flex-1 px-2 py-1 text-xs bg-surface-3 rounded border border-border focus:border-accent outline-none font-mono"
        />
        <button
          type="button"
          onClick={() => void onAdd(manualJid, null)}
          disabled={!manualJid.trim()}
          className="text-[11px] px-2 py-1 rounded border border-border bg-surface-3 hover:bg-surface-2 disabled:opacity-40"
        >
          Ignore
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-700 dark:text-rose-300">{error}</p>}
    </div>
  );
}

function CatchAllRouteToggle({ creatingCatchAll, setDraft, setManualMode, setError, hasCatchAll }: {
  creatingCatchAll: boolean;
  setDraft: React.Dispatch<React.SetStateAction<{ remote_jid: string; agent_id: string; label: string; }>>;
  setManualMode: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  hasCatchAll: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-[11px] text-fg-subtle flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={creatingCatchAll}
          onChange={(e) => {
            const on = e.target.checked;
            setDraft((d) => ({
              ...d,
              remote_jid: on ? "*" : "",
              label: on ? (d.label.trim() ? d.label : "Catch-all") : d.label,
            }));
            if (on) {
              setManualMode(false);
              setError(null);
            }
          }}
          disabled={hasCatchAll && !creatingCatchAll}
        />
        Catch everything else (fallback route)
      </label>
      {hasCatchAll && !creatingCatchAll && (
        <span className="text-[10px] text-fg-faint">Catch-all already exists</span>
      )}
    </div>
  );
}
