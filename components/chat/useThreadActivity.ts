"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { ThreadActivity } from "@/api/types";
import { applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

const BUSY_POLL_MS = 1_500;
const IDLE_POLL_MS = 5_000;
// A run's stream ends a moment before the registry marks it finished; a
// snapshot inside this window may still report the run that just ended.
const SETTLE_GRACE_MS = 2_000;

interface Params {
  threadId: string | null;
  attach: (threadId: string) => Promise<unknown>;
  /** Synchronous: does this client already own a live stream? */
  isLive: () => boolean;
  /** Epoch ms when this client's last stream settled. */
  lastSettledAt: () => number;
  metaApplier: ThreadMetaApplier;
}

/**
 * Poll what the thread is doing on the server and keep the chat in step:
 * re-attach to a turn started elsewhere (scheduler, watcher, bridge, another
 * device), restore compaction flags after a remount, and refresh the thread
 * metadata once a compaction finishes.
 */
export function useThreadActivity({ threadId, attach, isLive, lastSettledAt, metaApplier }: Params): ThreadActivity | null {
  const [activity, setActivity] = useState<ThreadActivity | null>(null);
  const deps = useRef({ attach, isLive, lastSettledAt, metaApplier });
  deps.current = { attach, isLive, lastSettledAt, metaApplier };

  useEffect(() => {
    setActivity(null);
    if (!threadId) return;
    let cancelled = false;
    let timer: number | null = null;
    let hadCompaction = false;

    const schedule = (ms: number) => {
      if (!cancelled) timer = window.setTimeout(tick, ms);
    };

    async function tick() {
      if (cancelled || !threadId) return;
      if (typeof document !== "undefined" && document.hidden) { schedule(IDLE_POLL_MS); return; }
      let next: ThreadActivity;
      try {
        next = await api.threads.activity(threadId);
      } catch {
        schedule(IDLE_POLL_MS);
        return;
      }
      if (cancelled) return;
      setActivity(next);
      const d = deps.current;

      const serverRunning = next.run !== null || next.queue_depth > 0;
      const recentlySettled = Date.now() - d.lastSettledAt() < SETTLE_GRACE_MS;
      if (serverRunning && !d.isLive() && !recentlySettled) {
        d.attach(threadId).catch(() => { /* best-effort */ });
      }

      if (next.compaction) {
        if (next.compaction.kind !== "refresh") d.metaApplier.setCompactionPending?.(true);
        if (next.compaction.kind === "manual") d.metaApplier.setManualCompactionPending?.(true);
        hadCompaction = true;
      } else if (hadCompaction) {
        hadCompaction = false;
        // The compaction just finished. Clear the flags from the snapshot
        // itself so a failed refresh below can't leave the chat locked, then
        // pull the new boundary and recap.
        d.metaApplier.setCompactionPending?.(false);
        d.metaApplier.setManualCompactionPending?.(false);
        api.threads.metadata(threadId)
          .then((meta) => { if (!cancelled) applyThreadMeta(deps.current.metaApplier, meta); })
          .catch((err) => { if (!cancelled) console.error("activity metadata refresh failed", err); });
      }

      schedule(next.busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    }

    // The thread load attaches to any in-flight run itself; give it a beat
    // so this poller doesn't race it with a second attach.
    schedule(BUSY_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [threadId]);

  return activity;
}
