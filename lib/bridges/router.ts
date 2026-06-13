import { findRoute, type BridgeRouteRow } from "@/lib/stores/bridges";

/**
 * Resolve which agent should handle an inbound message on (bridge, remote_jid).
 * 1) Exact route match on (bridge_id, remote_jid)
 * 2) Bridge-level catch-all route (`remote_jid='*'`) when present
 * 3) null (dispatcher drops the message silently)
 *
 * Catch-all lets one agent handle all otherwise-unrouted chats on a bridge.
 * This is especially useful for "triage" or "observer" agents.
 */
export function resolveRoute(bridge_id: string, remote_jid: string): BridgeRouteRow | null {
  return findRoute(bridge_id, remote_jid) ?? findRoute(bridge_id, "*");
}
