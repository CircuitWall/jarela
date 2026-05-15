// Tiny in-process pub/sub for app-level events the UI wants to surface as
// browser notifications. Run completions and scheduled-task firings both
// publish here; the frontend subscribes via a single SSE endpoint.

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
      status: "done" | "error";
      preview: string;
      error?: string;
      ts: number;
    };

type Listener = (ev: NotificationEvent) => void;

const listeners = new Set<Listener>();
const recent: NotificationEvent[] = [];
const RECENT_LIMIT = 50;

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
