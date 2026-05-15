"use client";
// In-app toast pub/sub. Same shape as our loading store — module-level state,
// React subscribers via a hook. Toasts come from the /events SSE feed and
// optionally fan out to the Web Notification API too.
import { useEffect, useState } from "react";

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  title: string;
  body: string;
  // For click-to-navigate
  agent_id: string | null;
  thread_id: string | null;
  // For unread charm tracking
  created_at: number;
  // Auto-dismiss timeout in ms (0 = sticky)
  ttl: number;
}

let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
let unread = 0;
const unreadListeners = new Set<(n: number) => void>();

function notify() {
  for (const l of listeners) l(toasts);
}
function notifyUnread() {
  for (const l of unreadListeners) l(unread);
}

export function pushToast(input: Omit<Toast, "id" | "created_at">): string {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const t: Toast = { ...input, id, created_at: Date.now() };
  toasts = [...toasts, t];
  unread += 1;
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
  if (unread === 0) return;
  unread = 0;
  notifyUnread();
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
  const [n, setN] = useState(unread);
  useEffect(() => {
    const fn = (v: number) => setN(v);
    unreadListeners.add(fn);
    setN(unread);
    return () => { unreadListeners.delete(fn); };
  }, []);
  return n;
}
