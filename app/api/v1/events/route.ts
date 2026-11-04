/**
 * @public — `GET /api/v1/events` (Server-Sent Events)
 *
 * Live app event stream — run completion, watcher fires, queue progress,
 * and transient run activity updates. UI and external scripts subscribe
 * over the same SSE wire format. See `docs/api.md`.
 */

import { NextRequest } from "next/server";
import { recentSince, subscribe, type AppEvent } from "@/lib/notifications/bus";
import { getActiveRunCount } from "@/lib/agents/run-registry";
import { startScheduler } from "@/lib/scheduler";
import { startAllBridges } from "@/lib/bridges/runtime";
import { sseResponse } from "@/lib/api/sse";
import { isMasterKeyLocked, onMasterKeyUnlocked } from "@/lib/crypto/master-key";

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

// Long-lived SSE stream of app events (notifications and activity status).
// The browser subscribes once on app boot and renders Web Notifications.
// Pass `?since=<unixMs>` to replay events newer than a timestamp on reconnect.
export function GET(req: NextRequest) {
  // Wake the scheduler on every SSE subscription. Cheap (idempotent), and
  // guarantees a freshly-loaded dev server has a ticking scheduler the
  // moment the UI opens its event stream — before this, the scheduler was
  // only started lazily on the first agent run, so a server restart could
  // leave scheduled tasks dormant until you sent a chat message.
  startScheduler();

  // Bring up enabled bridges (WhatsApp adapters). Idempotent — runtime.ts
  // pins state to globalThis so this is a no-op after the first call.
  // Fire-and-forget: bridge connect can take seconds, the SSE stream below
  // mustn't block waiting for WebSocket handshakes.
  //
  // Defer past the PIN unlock when locked (ADR-0063): startAllBridges
  // reads encrypted credentials and would throw MasterKeyLockedError.
  const launchBridges = () => {
    void startAllBridges().catch((err) => {
      console.error("[bridges] startAllBridges failed:", err);
    });
  };
  if (isMasterKeyLocked()) {
    onMasterKeyUnlocked(launchBridges);
  } else {
    launchBridges();
  }

  const url = new URL(req.url);
  const sinceTs = Number(url.searchParams.get("since")) || 0;
  let cancelStream = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let alive = true;
      let cleaned = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        alive = false;
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* */ }
      };
      cancelStream = cleanup;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (!alive) return;
        try { controller.enqueue(chunk); } catch { cleanup(); }
      };

      // Queue while replaying so notifications published in the replay window
      // are not lost or delivered twice.
      let replaying = true;
      const pending: AppEvent[] = [];
      unsubscribe = subscribe((ev) => {
        if (replaying) pending.push(ev);
        else safeEnqueue(sse({ ...ev }));
      });

      // Replay anything missed since the client's last seen timestamp.
      const replay = recentSince(sinceTs);
      const replayedTimestamps = new Set(replay.map((ev) => ev.ts));
      for (const ev of replay) {
        safeEnqueue(sse({ ...ev }));
      }
      for (const ev of pending) {
        if (ev.type !== "activity_update" && !replayedTimestamps.has(ev.ts)) {
          safeEnqueue(sse({ ...ev }));
        }
      }
      replaying = false;

      if (!alive) return;
      // Activity is a transient state update, not retained notification history.
      safeEnqueue(sse({ type: "activity_update", active_runs: getActiveRunCount() }));

      // Heartbeat so intermediate proxies don't time out the connection.
      heartbeat = setInterval(() => {
        safeEnqueue(enc.encode(": heartbeat\n\n"));
      }, 30_000);
      heartbeat.unref?.();

      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", cleanup);
    },
    cancel() { cancelStream(); },
  });

  return sseResponse(stream, { disableProxyBuffering: false });
}
