"use client";
import { useEffect, useRef } from "react";
import { pushToast, type NotifSource } from "@/lib/ui/toasts";

interface RunCompleted {
  type: "run_completed";
  thread_id: string;
  agent_id: string | null;
  status: "done" | "error";
  preview: string;
  ts: number;
}

interface TaskCompleted {
  type: "task_completed";
  task_id: string;
  agent_id: string;
  prompt: string;
  thread_id: string;
  status: "done" | "error" | "skipped";
  preview: string;
  error?: string;
  ts: number;
}

interface BridgeMessageReceived {
  type: "bridge_message_received";
  bridge_id: string;
  remote_jid: string;
  push_name: string | null;
  is_group: boolean;
  thread_id: string;
  agent_id: string;
  preview: string;
  ts: number;
}

// Browser-extension page-capture pushed a new user message into a thread.
// Surfaces only as a thread refresh — no toast, no OS notification, since
// the user just made the capture themselves and is already aware of it.
interface ThreadMessageAdded {
  type: "thread_message_added";
  thread_id: string;
  agent_id: string;
  source: "page_capture";
  ts: number;
}

type NotifEvent = RunCompleted | TaskCompleted | BridgeMessageReceived;
type StreamEvent = NotifEvent | ThreadMessageAdded;

interface AgentSummary {
  id: string;
  name: string;
}

interface Options {
  // Predicate: should this event surface as a toast / OS notification?
  // Returning false suppresses both — used when the user is currently
  // viewing the agent that completed (the message is already on screen).
  shouldNotify: (ev: NotifEvent) => boolean;
  // For titling the toast / notification.
  resolveAgentName: (agentId: string | null) => string;
  // Optional: return a URL to the agent's avatar so OS notifications show
  // the agent icon instead of the generic Jarela logo. Null/undefined →
  // fall back to /icon-192.png.
  resolveAgentIcon?: (agentId: string | null) => string | null | undefined;
}

// Subscribes to /api/v1/events. Each event:
//   - Always pushes an in-app toast (Teams-style card, bottom-right of the
//     Jarela window). Works whenever the window is visible — including in
//     the Edge sidebar.
//   - Additionally fires a Web Notification when the window is NOT focused
//     (background tab, minimized, focused-on-another-app). The OS surfaces
//     it even when Jarela isn't visible. Requires browser permission;
//     gracefully no-op when not granted.
// Persist the last-seen-event timestamp across reloads/relaunches.
// Without this, mobile users who background the PWA (which suspends SSE on
// iOS) miss every scheduler/cron event that fires while they were away,
// because the next mount initialised `lastTs` to Date.now() and the
// server's recentSince() replay returned nothing.
const LAST_TS_KEY = "jarela.notif.lastTs";
function loadLastTs(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(LAST_TS_KEY);
    const n = raw ? Number(raw) : 0;
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Clamp to the bus's RECENT_LIMIT window — older events are gone from
    // memory anyway, and we don't want to spam the user with day-old toasts
    // on the first reopen of a long-idle PWA.
    const MAX_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
    return Math.max(n, Date.now() - MAX_WINDOW_MS);
  } catch { return 0; }
}
function saveLastTs(ts: number): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LAST_TS_KEY, String(ts)); } catch { /* quota / privacy mode */ }
}

export function useEventNotifications(options: Options) {
  const lastTsRef = useRef<number>(loadLastTs());
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let cancelled = false;
    let backoff = 500;
    // Tracked so we can cancel a pending reconnect on unmount; otherwise
    // the timer fires after the component is gone and the resulting
    // EventSource leaks (and the cancelled-check doesn't help — we need
    // to also stop the timer that scheduled it).
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const url = `/api/v1/events?since=${lastTsRef.current}`;
      es = new EventSource(url);

      es.onmessage = (msg) => {
        backoff = 500;
        let ev: StreamEvent;
        try { ev = JSON.parse(msg.data) as StreamEvent; } catch { return; }
        if (!ev.ts) return;

        // Page-capture push: re-fetch the affected thread AND drop a small
        // toast so the user can see *which* agent received the capture
        // without having to switch to the chat view first. The capture
        // itself was made by the user, but the routing target (default
        // agent's most-recent thread) isn't necessarily the agent they're
        // currently looking at.
        if (ev.type === "thread_message_added") {
          lastTsRef.current = Math.max(lastTsRef.current, ev.ts);
          saveLastTs(lastTsRef.current);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
              detail: { thread_id: ev.thread_id, agent_id: ev.agent_id },
            }));
          }
          const agentName = optsRef.current.resolveAgentName(ev.agent_id);
          pushToast({
            kind: "info",
            source: "system",
            sourceLabel: "Page capture",
            title: `📎 Captured to ${agentName}`,
            body: "A page snippet was added to the most recent thread. Open Jarela to follow up.",
            agent_id: ev.agent_id,
            thread_id: ev.thread_id,
            ttl: 5000,
          });
          return;
        }

        // Ignore event types this hook doesn't surface (bridge_status,
        // bridge_unrouted, …). The badge would otherwise increment on every
        // pairing-state ping.
        if (
          ev.type !== "run_completed" &&
          ev.type !== "task_completed" &&
          ev.type !== "bridge_message_received"
        ) return;
        // Silent scheduled tasks that chose NO_REPLY publish status="skipped".
        // Suppress the badge/toast/OS notification — they intentionally
        // produced nothing for the user to see.
        if (ev.type === "task_completed" && ev.status === "skipped") return;
        lastTsRef.current = Math.max(lastTsRef.current, ev.ts);
        saveLastTs(lastTsRef.current);
        // Broadcast a thread-updated event regardless of whether we'll
        // surface a toast / OS notification. Other tabs / devices that
        // have the chat open for the same thread need to refetch their
        // message list even when shouldNotify() suppresses the ping
        // (e.g. the user is actively viewing this agent on the PC while
        // sending the message from iOS — without this they had to refresh
        // the chat window to see what they typed on the phone).
        const evThreadId = (ev as { thread_id?: string }).thread_id;
        if (evThreadId && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
            detail: { thread_id: evThreadId, agent_id: ev.agent_id ?? null },
          }));
        }
        handleEvent(ev);
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, Math.min(backoff, 30_000));
        backoff = Math.min(backoff * 2, 30_000);
      };
    }

    function handleEvent(ev: NotifEvent) {
      if (!optsRef.current.shouldNotify(ev)) return;

      const { title, body, kind, source, sourceLabel } =
        format(ev, optsRef.current.resolveAgentName);

      // Always push an in-app toast — it is the source of truth for the
      // per-agent unread badge (header menu icon, gear panel, chat agent
      // selector). The OS Web Notification is layered on top when permission
      // is granted so the user still gets a system ping if Jarela isn't
      // focused.
      pushToast({
        kind,
        source,
        sourceLabel,
        title,
        body,
        preview: ev.preview || undefined,
        agent_id: ev.agent_id,
        thread_id: ev.thread_id || null,
        ttl: 6000,
      });

      const canOSNotify =
        typeof Notification !== "undefined" && Notification.permission === "granted";
      if (canOSNotify) {
        try {
          const customIcon = optsRef.current.resolveAgentIcon?.(ev.agent_id) ?? null;
          // Tag uniquely per source/identity so a new run replaces the old
          // run-toast for the same thread, but doesn't collide with a task
          // or bridge ping that happens to share an id.
          const tag =
            ev.type === "run_completed"    ? `run:${ev.thread_id}` :
            ev.type === "task_completed"   ? `task:${ev.task_id}` :
            /* bridge_message_received */   `bridge:${ev.bridge_id}:${ev.remote_jid}`;
          const n = new Notification(title, {
            body: ev.preview ? `${body}\n\n${ev.preview}` : body,
            tag,
            icon: customIcon || "/icon-192.png",
          });
          // Click handler: focus the Jarela window, jump to the exact thread
          // the event happened in (or fall back to just the agent), dismiss
          // the OS notification.
          n.onclick = () => {
            window.focus();
            const agentId = ev.agent_id;
            const threadId = (ev as { thread_id?: string }).thread_id ?? null;
            if (agentId) {
              window.dispatchEvent(new CustomEvent("jarela:focus-agent", {
                detail: { agentId, threadId },
              }));
            }
            n.close();
          };
        } catch { /* OS rejected — toast is already up, nothing else to do */ }
      }
    }

    connect();
    // When the PWA comes back to the foreground (iOS suspends SSE in the
    // background, often without firing onerror), force a fresh reconnect so
    // the server's recentSince() replays anything that happened while away.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { es?.close(); } catch { /* */ }
      es = null;
      backoff = 500;
      connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      document.removeEventListener("visibilitychange", onVisible);
      es?.close();
    };
  }, []);
}

function format(ev: NotifEvent, resolveName: (id: string | null) => string): {
  title: string; body: string; kind: "info" | "success" | "error";
  source: NotifSource; sourceLabel: string;
} {
  const name = resolveName(ev.agent_id);
  if (ev.type === "run_completed") {
    return ev.status === "error"
      ? { title: `${name} — error`, body: ev.preview || "Run failed.",
          kind: "error", source: "run", sourceLabel: "Reply" }
      : { title: `${name} replied`, body: ev.preview || "Response ready.",
          kind: "info", source: "run", sourceLabel: "Reply" };
  }
  if (ev.type === "task_completed") {
    if (ev.status === "error") {
      return {
        title: `${name} — scheduled task failed`,
        body: ev.error ?? "Task failed.",
        kind: "error", source: "task", sourceLabel: "Scheduled task",
      };
    }
    return {
      // Show only the assistant reply preview — the prompt is what the user
      // already knows they scheduled, the value of the notification is the
      // answer that just arrived.
      title: `${name} — scheduled task completed`,
      body: ev.preview || "(no output)",
      kind: "success", source: "task", sourceLabel: "Scheduled task",
    };
  }
  // bridge_message_received
  // Direction matches the data flow: the inbound side messaged the agent.
  // Title reads "<sender> → <agent>" so the user sees who reached out to
  // which of their agents at a glance. For group chats the channel label
  // already says "WhatsApp group"; we also tag the sender with "(group)"
  // inside the title so it still reads correctly without the source pill.
  const who = ev.push_name || ev.remote_jid;
  const sender = ev.is_group ? `${who} (group)` : who;
  const channel = ev.is_group ? "WhatsApp group" : "WhatsApp";
  return {
    title: `${sender} → ${name}`,
    body: ev.preview || "(no reply)",
    kind: "info", source: "bridge", sourceLabel: channel,
  };
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return "denied"; }
}

export type { NotifEvent, AgentSummary };
