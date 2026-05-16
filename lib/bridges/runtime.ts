/**
 * Bridge lifecycle manager.
 *
 * Owns a `Map<bridge_id, BridgeAdapter>` plus a `Map<bridge_id, StatusUpdate>`
 * of the latest known status per bridge (so the HTTP status endpoint can
 * return live QR / connection state without consulting the adapter directly).
 *
 * - `startAllBridges()` — called at app boot; scans `bridges` for
 *   `enabled=1` rows and spins up their adapters.
 * - `startBridge(id)` / `stopBridge(id)` / `restartBridge(id)` — called from
 *   the HTTP layer (toggle enabled, re-pair, delete).
 *
 * Pinned to globalThis so dev HMR doesn't double-start (same pattern as
 * lib/scheduler/index.ts).
 */

import { getBridge, listBridges, updateBridge } from "@/lib/stores/bridges";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { handleInboundMessage } from "./dispatcher";
import { WhatsAppBridgeAdapter } from "./whatsapp";
import type { BridgeAdapter, StatusUpdate } from "./types";

interface RuntimeState {
  adapters: Map<string, BridgeAdapter>;
  status: Map<string, StatusUpdate>;
  started: boolean;
}
const g = globalThis as unknown as { __langgui_bridges?: RuntimeState };
if (!g.__langgui_bridges) {
  g.__langgui_bridges = {
    adapters: new Map(),
    status: new Map(),
    started: false,
  };
}
const state = g.__langgui_bridges;

function makeAdapter(bridge_id: string, kind: string): BridgeAdapter {
  switch (kind) {
    case "whatsapp":
      return new WhatsAppBridgeAdapter(bridge_id);
    default:
      throw new Error(`Unknown bridge kind: ${kind}`);
  }
}

function wireAdapter(adapter: BridgeAdapter): void {
  adapter.onInboundMessage((msg) => handleInboundMessage(adapter, msg));
  adapter.onStatusChange((update) => {
    state.status.set(adapter.bridge_id, update);
    // Persist the user-visible bits so they survive a process restart.
    const patch: Parameters<typeof updateBridge>[1] = {
      status: update.status,
      qr: update.qr_data_url ?? null,
      last_error: update.error ?? null,
    };
    if (update.paired_id !== undefined) patch.paired_id = update.paired_id;
    updateBridge(adapter.bridge_id, patch);
    publishNotification({
      type: "bridge_status",
      bridge_id: adapter.bridge_id,
      status: update.status,
      error: update.error ?? null,
      paired_id: update.paired_id ?? null,
      ts: Date.now(),
    });
  });
}

export async function startBridge(bridge_id: string): Promise<void> {
  if (state.adapters.has(bridge_id)) return;
  const row = getBridge(bridge_id);
  if (!row) throw new Error(`Bridge ${bridge_id} not found`);
  const adapter = makeAdapter(bridge_id, row.kind);
  state.adapters.set(bridge_id, adapter);
  wireAdapter(adapter);
  try {
    await adapter.start();
  } catch (err) {
    state.adapters.delete(bridge_id);
    const m = err instanceof Error ? err.message : String(err);
    updateBridge(bridge_id, { status: "error", last_error: m });
    throw err;
  }
}

export async function stopBridge(bridge_id: string): Promise<void> {
  const adapter = state.adapters.get(bridge_id);
  state.adapters.delete(bridge_id);
  state.status.delete(bridge_id);
  if (adapter) {
    try { await adapter.stop(); }
    catch (err) {
      console.error(`[bridge ${bridge_id}] stop failed:`, err);
    }
  }
  // Persist that the bridge is down (in case status callback didn't fire).
  updateBridge(bridge_id, { status: "disconnected", qr: null });
}

export async function restartBridge(bridge_id: string): Promise<void> {
  await stopBridge(bridge_id);
  await startBridge(bridge_id);
}

export async function repairBridge(bridge_id: string): Promise<void> {
  // Wipe creds on disk + restart. Adapter will produce a fresh QR.
  const adapter = state.adapters.get(bridge_id);
  if (adapter) {
    try { await adapter.resetAuth(); } catch { /* ignore */ }
    state.adapters.delete(bridge_id);
    state.status.delete(bridge_id);
  } else {
    // Not running — wipe the dir directly via a temporary adapter so callers
    // can re-pair an idle bridge without first enabling it.
    const tmp = makeAdapter(bridge_id, getBridge(bridge_id)?.kind ?? "whatsapp");
    await tmp.resetAuth();
  }
  updateBridge(bridge_id, { status: "disconnected", qr: null, last_error: null, paired_id: null });
  await startBridge(bridge_id);
}

export function getBridgeRuntimeStatus(bridge_id: string): StatusUpdate | null {
  return state.status.get(bridge_id) ?? null;
}

export function isBridgeRunning(bridge_id: string): boolean {
  return state.adapters.has(bridge_id);
}

/**
 * Snapshot of chats the adapter has observed since connecting. Returns []
 * when the bridge isn't running yet. Triggers a background refresh so that
 * subsequent calls see newly-fetched group metadata.
 */
export function listBridgeChats(bridge_id: string) {
  const adapter = state.adapters.get(bridge_id);
  if (!adapter) return [];
  // Fire-and-forget — refreshChats hits a WS round-trip; HTTP shouldn't
  // wait. The next poll will pick up any new entries.
  void adapter.refreshChats().catch(() => { /* logged inside */ });
  return adapter.listChats();
}

/**
 * Look up a freeform phone number (or other identifier) against the bridge
 * and return the resolved chat if it exists, else null. Returns null also
 * if the bridge isn't running.
 */
export async function lookupBridgeChat(bridge_id: string, input: string) {
  const adapter = state.adapters.get(bridge_id);
  if (!adapter) return null;
  return adapter.lookupChat(input);
}

/**
 * Boot hook. Idempotent — safe to call from a layout module that may be
 * evaluated multiple times in Next.js dev HMR.
 */
export async function startAllBridges(): Promise<void> {
  if (state.started) return;
  state.started = true;
  const rows = listBridges();
  for (const row of rows) {
    if (row.enabled !== 1) continue;
    try {
      await startBridge(row.id);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[bridge ${row.id}] failed to start at boot:`, m);
      // updateBridge already happened inside startBridge's catch.
    }
  }
}
