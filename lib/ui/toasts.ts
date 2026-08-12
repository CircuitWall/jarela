"use client";
// In-app toast pub/sub. Same shape as our loading store — module-level state,
// React subscribers via a hook. Toasts come from the /events SSE feed and
// optionally fan out to the Web Notification API too.
//
// Unread tracking is per-agent so the menu icon (header) and per-agent UI
// surfaces (gear panel agent list, chat agent selector) can render their
// own breakdowns from the same source of truth.
import { useEffect, useState } from "react";
// Type-only import — no runtime cycle with error-report.ts.
import type { ErrorReportInput } from "./error-report";

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
  // Full technical details (stack trace, JSON envelope) revealed by the
  // expand chevron on error toasts. Set by pushErrorToast.
  details?: string;
  // When present the Toaster renders the "Report this issue" button which
  // opens a pre-filled GitHub issue. Set by pushErrorToast.
  reportInput?: ErrorReportInput;
  // Collapses repeat pushes into the same visible toast. When a new push
  // arrives with a dedupeKey already on-screen we update that toast in
  // place (same id, refreshed created_at, refreshed ttl) instead of
  // stacking another card. Combined with a non-zero ttl this yields
  // "persist while the error keeps re-firing, auto-dismiss once it
  // stops" — e.g. a probe recovering, or a user-action failure that
  // isn't retried.
  dedupeKey?: string;
}

let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
// Per-toast auto-dismiss handles, keyed by toast id. Tracked at the store
// layer so dedupe refresh can cancel+reschedule the timer without leaking
// stale timeouts (which would otherwise fire a dismiss on the *refreshed*
// toast at the *original* deadline).
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDismiss(id: string, ttl: number): void {
  const existing = dismissTimers.get(id);
  if (existing) clearTimeout(existing);
  dismissTimers.delete(id);
  if (ttl > 0) {
    const handle = setTimeout(() => {
      dismissTimers.delete(id);
      dismissToast(id);
    }, ttl);
    dismissTimers.set(id, handle);
  }
}

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
  // Dedupe path: if a toast with the same dedupeKey is already on-screen,
  // update it in place. We keep the original id (so the Toaster's ToastCard
  // stays mounted and preserves user state like the expanded-details panel)
  // and bump created_at so the card's countdown / progress-bar effect
  // resets from "now". We deliberately do NOT bump the unread counter on
  // an update — a re-firing error shouldn't keep incrementing the badge.
  if (input.dedupeKey) {
    const existing = toasts.find((t) => t.dedupeKey === input.dedupeKey);
    if (existing) {
      const updated: Toast = {
        ...existing,
        ...input,
        id: existing.id,
        created_at: Date.now(),
      };
      toasts = toasts.map((t) => (t.id === existing.id ? updated : t));
      scheduleDismiss(existing.id, updated.ttl);
      notify();
      return existing.id;
    }
  }
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const t: Toast = { ...input, id, created_at: Date.now() };
  toasts = [...toasts, t];
  // Defensive normalisation: malformed producer payloads can send empty
  // strings for agent_id. Treat them as null so the unread bucket remains
  // consumable via the same system-alert clear path.
  const key = t.agent_id && t.agent_id.trim().length > 0 ? t.agent_id : null;
  unreadByAgent.set(key, (unreadByAgent.get(key) ?? 0) + 1);
  notify();
  notifyUnread();
  scheduleDismiss(id, t.ttl);
  return id;
}

export function dismissToast(id: string): void {
  const existing = dismissTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    dismissTimers.delete(id);
  }
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) notify();
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

