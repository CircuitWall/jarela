"use client";
import { useEffect, useRef } from "react";

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
  status: "done" | "error";
  preview: string;
  error?: string;
  ts: number;
}

type NotifEvent = RunCompleted | TaskCompleted;

interface AgentSummary {
  id: string;
  name: string;
}

interface Options {
  // Predicate: should we notify for this event? Returning false suppresses.
  // Used so we don't notify when the user is already viewing the agent that
  // just completed (the message is right there on screen).
  shouldNotify: (ev: NotifEvent) => boolean;
  // Used to title the notification with the agent's display name.
  resolveAgentName: (agentId: string | null) => string;
}

// Browser-side: subscribes to /api/v1/events, requests notification permission
// on first event arrival, and emits a Web Notification per relevant event.
// Survives page reloads via the `since` query param (replays missed events).
export function useEventNotifications(options: Options) {
  const lastTsRef = useRef<number>(Date.now());
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let cancelled = false;
    let backoff = 500;

    function connect() {
      if (cancelled) return;
      const url = `/api/v1/events?since=${lastTsRef.current}`;
      es = new EventSource(url);

      es.onmessage = (msg) => {
        backoff = 500;
        let ev: NotifEvent;
        try { ev = JSON.parse(msg.data) as NotifEvent; } catch { return; }
        if (!ev.ts) return;
        lastTsRef.current = Math.max(lastTsRef.current, ev.ts);
        handleEvent(ev);
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        // Reconnect with exponential backoff (max 30s).
        setTimeout(connect, Math.min(backoff, 30_000));
        backoff = Math.min(backoff * 2, 30_000);
      };
    }

    function handleEvent(ev: NotifEvent) {
      if (!optsRef.current.shouldNotify(ev)) return;

      const requestAndShow = () => {
        if (Notification.permission === "granted") show(ev);
        else if (Notification.permission === "default") {
          Notification.requestPermission().then((p) => {
            if (p === "granted") show(ev);
          });
        }
      };

      requestAndShow();
    }

    function show(ev: NotifEvent) {
      try {
        if (ev.type === "run_completed") {
          const name = optsRef.current.resolveAgentName(ev.agent_id);
          const title = ev.status === "error" ? `${name} — error` : `${name} replied`;
          new Notification(title, {
            body: ev.preview || (ev.status === "error" ? "Run failed." : "Response ready."),
            tag: `run:${ev.thread_id}`,
            icon: "/icon-192.png",
          });
        } else if (ev.type === "task_completed") {
          const name = optsRef.current.resolveAgentName(ev.agent_id);
          const title = ev.status === "error"
            ? `${name} — scheduled task failed`
            : `${name} — scheduled task completed`;
          const body = ev.status === "error"
            ? ev.error ?? "Task failed."
            : `${truncate(ev.prompt, 50)} → ${truncate(ev.preview || "(no output)", 80)}`;
          new Notification(title, {
            body,
            tag: `task:${ev.task_id}`,
            icon: "/icon-192.png",
          });
        }
      } catch { /* notification API errored — ignore */ }
    }

    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// Helper to expose for AppShell — request permission on a user gesture so we
// don't get auto-blocked.
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export type { NotifEvent, AgentSummary };
