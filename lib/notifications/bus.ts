// Tiny in-process pub/sub for app-level events the UI wants to surface as
// browser notifications. Run completions and scheduled-task firings both
// publish here; the frontend subscribes via a single SSE endpoint.

import { getConfig } from "@/lib/env/config";

export type NotificationEvent =
  | {
      type: "run_completed";
      thread_id: string;
      agent_id: string | null;
      status: "done" | "error";
      preview: string;       // first ~100 chars of assistant reply
      ts: number;
    }
  | {
      type: "task_completed";
      task_id: string;
      agent_id: string;
      prompt: string;
      thread_id: string;
      // "skipped" is emitted when a silent scheduled task ran but the agent
      // chose not to surface a reply (NO_REPLY sentinel or empty). The chat
      // already stays quiet via messages.hidden; downstream notification
      // sinks can drop the ping too.
      status: "done" | "error" | "skipped";
      preview: string;
      error?: string;
      ts: number;
    }
  | {
      // Bridge replied to an inbound message on a configured route.
      type: "bridge_message_received";
      bridge_id: string;
      remote_jid: string;
      push_name: string | null;
      is_group: boolean;
      thread_id: string;
      agent_id: string;
      preview: string;       // first ~120 chars of assistant reply
      ts: number;
    }
  | {
      // Bridge received a message from a chat that has no route configured.
      // Advisory only — surfaced in the UI as a "Add route" hint so the user
      // can copy the JID into a new route. The message itself is dropped.
      type: "bridge_unrouted";
      bridge_id: string;
      remote_jid: string;
      push_name: string | null;
      is_group: boolean;
      preview: string;
      ts: number;
    }
  | {
      // Bridge connection lifecycle: disconnected | pairing | connected | error.
      // Lets the UI flip status pills and surface QR data URLs live without
      // polling.
      type: "bridge_status";
      bridge_id: string;
      status: "disconnected" | "pairing" | "connected" | "error";
      error: string | null;
      paired_id: string | null;
      ts: number;
    }
  | {
      // A new message landed in a thread without an active LLM run firing —
      // currently published by the browser-extension page-capture route so
      // the open chat view re-fetches without waiting for the next run.
      type: "thread_message_added";
      thread_id: string;
      agent_id: string;
      source: "page_capture";
      ts: number;
    };

import { getOrCreateGlobal } from "@/lib/utils/global-state";

type Listener = (ev: NotificationEvent) => void;
// JARELA_NOTIFICATION_RING_SIZE overrides this. Captured at module init —
// changes require restart.
const RECENT_LIMIT = getConfig().notificationRingSize;

interface BusState {
  listeners: Set<Listener>;
  recent: NotificationEvent[];
}
const busState = getOrCreateGlobal<BusState>("__jarela_notif_bus", () => ({
  listeners: new Set<Listener>(),
  recent: [],
}));
const listeners = busState.listeners;
const recent = busState.recent;

export function publish(ev: NotificationEvent): void {
  recent.push(ev);
  if (recent.length > RECENT_LIMIT) recent.shift();
  for (const l of listeners) {
    try { l(ev); } catch { /* listener errored, ignore */ }
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Replay events newer than `sinceTs` (used when a client reconnects).
export function recentSince(sinceTs: number): NotificationEvent[] {
  return recent.filter((e) => e.ts > sinceTs);
}
