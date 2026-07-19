import { findRoute, isIgnored, type BridgeRouteRow } from "@/lib/stores/bridges";

/**
 * Resolve which agent should handle an inbound message on (bridge, remote_jid).
 * 0) Chat is on the ignore list → null (message dropped before any agent
 *    thread, memory write, or tool call runs — the "listen to everything
 *    except these chats" primitive).
 * 1) Exact route match on (bridge_id, remote_jid)
 * 2) Bridge-level catch-all route (`remote_jid='*'`) when present
 * 3) null (dispatcher drops the message silently)
 *
 * Catch-all lets one agent handle all otherwise-unrouted chats on a bridge.
 * This is especially useful for "triage" or "observer" agents. The ignore
 * list is checked FIRST so it wins over both explicit routes and the
 * catch-all — deleting an ignore entry is how you "resume listening".
 */
export function resolveRoute(bridge_id: string, remote_jid: string): BridgeRouteRow | null {
  if (isIgnored(bridge_id, remote_jid)) return null;
  return findRoute(bridge_id, remote_jid) ?? findRoute(bridge_id, "*");
}
