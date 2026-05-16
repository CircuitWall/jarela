"use client";
import { useEffect, useRef } from "react";
import { pushToast } from "@/lib/ui/toasts";

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
  // Predicate: should this event surface as a toast / OS notification?
  // Returning false suppresses both — used when the user is currently
  // viewing the agent that completed (the message is already on screen).
  shouldNotify: (ev: NotifEvent) => boolean;
  // For titling the toast / notification.
  resolveAgentName: (agentId: string | null) => string;
}

// Subscribes to /api/v1/events. Each event:
//   - Always pushes an in-app toast (Teams-style card, bottom-right of the
//     LangGUI window). Works whenever the window is visible — including in
//     the Edge sidebar.
//   - Additionally fires a Web Notification when the window is NOT focused
//     (background tab, minimized, focused-on-another-app). The OS surfaces
//     it even when LangGUI isn't visible. Requires browser permission;
//     gracefully no-op when not granted.
// Persist the last-seen-event timestamp across reloads/relaunches.
// Without this, mobile users who background the PWA (which suspends SSE on
// iOS) miss every scheduler/cron event that fires while they were away,
// because the next mount initialised `lastTs` to Date.now() and the
// server's recentSince() replay returned nothing.
const LAST_TS_KEY = "langgui.notif.lastTs";
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
        saveLastTs(lastTsRef.current);
        handleEvent(ev);
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        setTimeout(connect, Math.min(backoff, 30_000));
        backoff = Math.min(backoff * 2, 30_000);
      };
    }

    function handleEvent(ev: NotifEvent) {
      if (!optsRef.current.shouldNotify(ev)) return;

      const { title, body, kind } = format(ev, optsRef.current.resolveAgentName);

      // 1. Always push an in-app toast. Visible whenever the LangGUI window
      //    has any pixels on screen.
      pushToast({
        kind,
        title,
        body,
        agent_id: ev.type === "run_completed" ? ev.agent_id : ev.agent_id,
        thread_id: ev.thread_id || null,
        ttl: 6000,
      });

      // 2. ALSO fire a Web Notification when the window isn't in focus, so
      //    macOS / Windows shows it on top of whatever the user is looking
      //    at. Quietly skipped if permission isn't granted — the toast is
      //    enough on its own.
      const unfocused = document.hidden || !document.hasFocus();
      if (unfocused && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const n = new Notification(title, {
            body,
            tag: ev.type === "run_completed" ? `run:${ev.thread_id}` : `task:${ev.task_id}`,
            icon: "/icon-192.png",
          });
          // Click handler: focus the LangGUI window, switch to the agent the
          // event belongs to, dismiss the OS notification. Same end state as
          // clicking the in-app toast card.
          n.onclick = () => {
            window.focus();
            const agentId = ev.agent_id;
            if (agentId) {
              window.dispatchEvent(new CustomEvent("langgui:focus-agent", {
                detail: { agentId },
              }));
            }
            n.close();
          };
        } catch { /* OS rejected, ignore */ }
      }
    }

    connect();
    // When the PWA comes back to the foreground (iOS suspends SSE in the
    // background, often without firing onerror), force a fresh reconnect so
    // the server's recentSince() replays anything that happened while away.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      try { es?.close(); } catch { /* */ }
      es = null;
      backoff = 500;
      connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      es?.close();
    };
  }, []);
}

function format(ev: NotifEvent, resolveName: (id: string | null) => string): {
  title: string; body: string; kind: "info" | "success" | "error";
} {
  if (ev.type === "run_completed") {
    const name = resolveName(ev.agent_id);
    return ev.status === "error"
      ? { title: `${name} — error`, body: ev.preview || "Run failed.", kind: "error" }
      : { title: `${name} replied`, body: ev.preview || "Response ready.", kind: "info" };
  }
  // task_completed
  const name = resolveName(ev.agent_id);
  if (ev.status === "error") {
    return {
      title: `${name} — scheduled task failed`,
      body: ev.error ?? "Task failed.",
      kind: "error",
    };
  }
  return {
    title: `${name} — scheduled task completed`,
    body: `${truncate(ev.prompt, 50)} → ${truncate(ev.preview || "(no output)", 80)}`,
    kind: "success",
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return "denied"; }
}

export type { NotifEvent, AgentSummary };
