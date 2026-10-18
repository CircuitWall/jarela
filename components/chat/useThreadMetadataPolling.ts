"use client";
import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import { applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

export function useThreadMetadataPolling(
  threadId: string | null,
  enabled: boolean,
  metaApplier: ThreadMetaApplier,
) {
  const metaRef = useRef(metaApplier);
  metaRef.current = metaApplier;

  useEffect(() => {
    if (!threadId || !enabled) return;
    const targetThreadId = threadId;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const schedule = () => {
      if (!cancelled && !document.hidden) timer = window.setTimeout(tick, 1600);
    };
    async function tick() {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const metadata = await api.threads.metadata(targetThreadId, controller.signal);
        if (!cancelled) applyThreadMeta(metaRef.current, metadata);
      } catch (err) {
        if (!cancelled) console.error("thread metadata refresh failed", err);
      } finally {
        inFlight = false;
        schedule();
      }
    }
    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [threadId, enabled]);
}
