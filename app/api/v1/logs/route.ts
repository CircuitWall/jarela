// Live server-log feed for the Logs panel.
//
// GET /api/v1/logs              — replay ring + subscribe to new lines (SSE)
// GET /api/v1/logs?since=<seq>  — replay only entries newer than this seq
//                                  (used by the panel on reconnect)
// GET /api/v1/logs?recent=<N>   — return the most recent N entries as JSON
//                                  (no SSE — for snapshot/export)
//
// SSE events are JSON-encoded LogEntry objects, one per `data:` line. The
// `seq` field on each entry lets the client drop duplicates if the EventSource
// reconnects (similar pattern to how lib/agents/run-registry.ts replays).
//
// See ADR-0058.

import { NextRequest, NextResponse } from "next/server";
import { sseResponse } from "@/lib/api/sse";
import {
  recentEntries,
  subscribe,
  installConsolePatch,
  type LogEntry,
} from "@/lib/logging/sink";

// Auto-install the console patch on first request. instrumentation-node.ts
// installs it eagerly in production, but dev / edge-runtime skip the boot
// hook — without this fallback, dev would silently see no logs in the
// panel. installConsolePatch is idempotent.
let _patched = false;
function ensurePatched(): void {
  if (_patched) return;
  installConsolePatch();
  _patched = true;
}

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

export async function GET(req: NextRequest) {
  ensurePatched();
  const url = new URL(req.url);
  const recentParam = url.searchParams.get("recent");
  if (recentParam) {
    // Snapshot mode — return JSON array, no streaming.
    const n = Math.max(0, Math.min(2000, Number(recentParam) | 0));
    return NextResponse.json({ entries: recentEntries(n) });
  }

  const sinceParam = url.searchParams.get("since");
  const sinceSeq = sinceParam ? Math.max(0, Number(sinceParam) | 0) : 0;

  // Hoisted cleanup so the cancel() callback can reach into start()'s
  // closure when the client disconnects (browser tab closed, panel
  // unmounted, navigation away). ReadableStream doesn't pass the
  // controller into cancel(), so we stash the unsub + heartbeat handles
  // here.
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let clientGone = false;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (clientGone) return;
        try { controller.enqueue(chunk); } catch { clientGone = true; }
      };

      // Replay ring filtered by since-seq.
      for (const entry of recentEntries()) {
        if (entry.seq > sinceSeq) safeEnqueue(sse(entry));
      }

      // Subscribe for live entries until the client disconnects.
      const unsubscribe = subscribe((entry: LogEntry) => {
        safeEnqueue(sse(entry));
      });

      // Heartbeat every 25s so corporate proxies don't kill an idle
      // connection. SSE comments (lines starting with ":") are ignored
      // by EventSource on the client.
      const heartbeat = setInterval(() => {
        if (clientGone) return;
        try { controller.enqueue(enc.encode(": heartbeat\n\n")); } catch { clientGone = true; }
      }, 25_000);
      heartbeat.unref?.();

      cleanup = () => {
        clientGone = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return sseResponse(stream);
}
