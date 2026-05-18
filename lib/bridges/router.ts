import { findRoute, type BridgeRouteRow } from "@/lib/stores/bridges";

/**
 * Resolve which agent should handle an inbound message on (bridge, remote_jid).
 * Returns `null` for unconfigured chats — the dispatcher then drops the
 * message silently (no thread created, no reply sent).
 *
 * v1: no fallback agent. To onboard a new contact, the user adds a
 * `bridge_routes` row via the UI.
 */
export function resolveRoute(bridge_id: string, remote_jid: string): BridgeRouteRow | null {
  return findRoute(bridge_id, remote_jid);
}

/** Back-compat shim — prefer `resolveRoute` so callers can read silent_mode. */
export function resolveAgent(bridge_id: string, remote_jid: string): string | null {
  return resolveRoute(bridge_id, remote_jid)?.agent_id ?? null;
}
