"use client";
// In-app toast pub/sub. Same shape as our loading store — module-level state,
// React subscribers via a hook. Toasts come from the /events SSE feed and
// optionally fan out to the Web Notification API too.
//
// Unread tracking is per-agent so the menu icon (header) and per-agent UI
// surfaces (gear panel agent list, chat agent selector) can render their
// own breakdowns from the same source of truth.
import { useEffect, useState } from "react";

// Source the notification originated from — used by toasts/OS notifications
// to label "what triggered this" so the user can tell a scheduled task ping
// apart from a fresh agent reply or a bridged WhatsApp message.
export type NotifSource = "run" | "task" | "bridge" | "system";

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  source: NotifSource;
  // Human label for the source, e.g. "Scheduled task", "WhatsApp", "Reply".
  sourceLabel: string;
  title: string;
  body: string;
  // Optional snippet of the actual content (assistant reply preview).
  preview?: string;
  // For click-to-navigate
  agent_id: string | null;
  thread_id: string | null;
  // Optional in-app deep link rendered as an action button on the toast
  // (e.g. "Open in Settings →" after an approval). Parsed by lib/ui/navigate.
  href?: string;
  hrefLabel?: string;
  // For unread charm tracking
  created_at: number;
  // Auto-dismiss timeout in ms (0 = sticky)
  ttl: number;
}

let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

// Per-agent unread counts. The `null` bucket holds events with no agent
// (system messages). Total = sum of all buckets.
const unreadByAgent = new Map<string | null, number>();
const unreadListeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l(toasts);
}
function notifyUnread() {
  for (const l of unreadListeners) l();
}

export function pushToast(input: Omit<Toast, "id" | "created_at">): string {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const t: Toast = { ...input, id, created_at: Date.now() };
  toasts = [...toasts, t];
  const key = t.agent_id;
  unreadByAgent.set(key, (unreadByAgent.get(key) ?? 0) + 1);
  notify();
  notifyUnread();
  if (t.ttl > 0) {
    setTimeout(() => dismissToast(id), t.ttl);
  }
  return id;
}

export function dismissToast(id: string): void {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) notify();
}

export function clearUnread(): void {
  if (unreadByAgent.size === 0) return;
  unreadByAgent.clear();
  notifyUnread();
}

export function clearUnreadForAgent(agentId: string | null): void {
  if (!unreadByAgent.has(agentId)) return;
  unreadByAgent.delete(agentId);
  notifyUnread();
}

function snapshotByAgent(): Map<string | null, number> {
  return new Map(unreadByAgent);
}

function totalUnread(): number {
  let n = 0;
  for (const v of unreadByAgent.values()) n += v;
  return n;
}

export function useToasts(): Toast[] {
  const [s, setS] = useState<Toast[]>(toasts);
  useEffect(() => {
    const fn = (t: Toast[]) => setS(t);
    listeners.add(fn);
    setS(toasts);
    return () => { listeners.delete(fn); };
  }, []);
  return s;
}

export function useUnreadCount(): number {
  const [n, setN] = useState<number>(() => totalUnread());
  useEffect(() => {
    const fn = () => setN(totalUnread());
    unreadListeners.add(fn);
    fn();
    return () => { unreadListeners.delete(fn); };
  }, []);
  return n;
}

// Read-only snapshot of per-agent unread counts. Subscribers re-render on
// every push/clear — cheap because the map is tiny.
export function useUnreadByAgent(): Map<string | null, number> {
  const [m, setM] = useState<Map<string | null, number>>(() => snapshotByAgent());
  useEffect(() => {
    const fn = () => setM(snapshotByAgent());
    unreadListeners.add(fn);
    fn();
    return () => { unreadListeners.delete(fn); };
  }, []);
  return m;
}

export function useUnreadForAgent(agentId: string | null): number {
  const m = useUnreadByAgent();
  return m.get(agentId) ?? 0;
}
