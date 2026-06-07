/**
 * @public — `GET /api/v1/events` (Server-Sent Events)
 *
 * Live notification stream — run completion, watcher fires, queue
 * progress, etc. UI subscribes here for real-time updates; external
 * scripts can subscribe over the same SSE wire format. See `docs/api.md`.
 */

import { NextRequest } from "next/server";
import { recentSince, subscribe } from "@/lib/notifications/bus";
import { startScheduler } from "@/lib/scheduler";
import { startAllBridges } from "@/lib/bridges/runtime";
import { sseResponse } from "@/lib/api/sse";
import { isMasterKeyLocked, onMasterKeyUnlocked } from "@/lib/crypto/master-key";

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

// Long-lived SSE stream of app events (run completions, scheduled-task fires).
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

  const stream = new ReadableStream({
    start(controller) {
      let alive = true;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (!alive) return;
        try { controller.enqueue(chunk); } catch { alive = false; }
      };

      // Replay anything missed since the client's last seen timestamp.
      for (const ev of recentSince(sinceTs)) {
        safeEnqueue(sse({ ...ev }));
      }

      // Subscribe to live events.
      const unsubscribe = subscribe((ev) => {
        safeEnqueue(sse({ ...ev }));
      });

      // Heartbeat so intermediate proxies don't time out the connection.
      const heartbeat = setInterval(() => {
        safeEnqueue(enc.encode(": heartbeat\n\n"));
      }, 30_000);
      heartbeat.unref?.();

      const cleanup = () => {
        alive = false;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* */ }
      };

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() { /* alive flag flips on next enqueue attempt */ },
  });

  return sseResponse(stream, { disableProxyBuffering: false });
}
