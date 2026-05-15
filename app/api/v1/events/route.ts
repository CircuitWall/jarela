import { NextRequest } from "next/server";
import { recentSince, subscribe } from "@/lib/notifications/bus";

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

// Long-lived SSE stream of app events (run completions, scheduled-task fires).
// The browser subscribes once on app boot and renders Web Notifications.
// Pass `?since=<unixMs>` to replay events newer than a timestamp on reconnect.
export function GET(req: NextRequest) {
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
