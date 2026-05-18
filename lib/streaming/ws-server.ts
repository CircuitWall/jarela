import { WebSocket, WebSocketServer } from "ws";

// Heartbeat tuning. Network changes (Wi-Fi switch, VPN attach/detach, NAT
// rebinding) silently kill the underlying TCP path without firing any WS
// close. These intervals make the server prove liveness on a regular cadence
// so dead clients get reaped and live clients see a steady trickle of
// messages — the latter is what the browser-side stall watchdog keys on,
// since the WS API doesn't surface ping/pong frames to JS.
const PING_INTERVAL_MS = 30_000;       // ws-level ping every 30s
const KEEPALIVE_INTERVAL_MS = 20_000;  // app-level {type:"keepalive"} during a run

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}
import type { StreamOptions } from "@/lib/agents/base";
import {
  prepareThreadRun,
  persistAssistantMessage,
  RunThreadError,
  shouldEmitChunk,
} from "@/lib/agents/run-thread";
import { startRun, finishRun, getRun, broadcast } from "@/lib/agents/run-registry";
import { getThread } from "@/lib/stores/threads";
import type { PersistedToolEvent } from "@/lib/stores/threads";
import { requireAccess } from "@/lib/auth/access";

type WsRunRequest = {
  thread_id: string;
  message: string;
  stream_options?: StreamOptions;
};

type WsServerState = {
  server: WebSocketServer;
  port: number;
};

declare global {
  var __jarelaWsState: WsServerState | undefined;
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function runAndStream(ws: WebSocket, req: WsRunRequest): Promise<void> {
  let assistantContent = "";
  const usedTools: string[] = [];
  const toolEvents: PersistedToolEvent[] = [];
  // App-level keepalive: even if the model is mid-thought and emits no
  // chunks for a while, push a small heartbeat the client can use to
  // confirm the path is alive. WebSocket ping frames are auto-handled by
  // the browser and not visible to JS, so we need a JSON message for the
  // browser-side stall watchdog to reset.
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: "keepalive", ts: Date.now() });
    }
  }, KEEPALIVE_INTERVAL_MS);
  // Refuse if another run is already active for this thread (the HTTP route
  // enforces this too; the WS path must mirror it so DELETE-abort and the
  // queue-drain UX behave the same regardless of transport).
  const existing = getRun(req.thread_id);
  if (existing && existing.status === "running") {
    sendJson(ws, { type: "error", message: "A run is already in progress for this thread", code: "run_active" });
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "run_active");
    return;
  }
  const thread = getThread(req.thread_id);
  const active = startRun(req.thread_id, thread?.agent_id ?? null);
  let terminal: "done" | "error" = "done";
  try {
    const prepared = await prepareThreadRun(
      req.thread_id,
      req.message,
      req.stream_options,
      undefined,
      active.abort.signal,
    );
    for await (const chunk of prepared.stream) {
      if (chunk.type === "text_delta") {
        assistantContent += String(chunk.data.delta ?? "");
      } else if (chunk.type === "tool_call") {
        const d = chunk.data as { id?: string; name?: string; arguments?: unknown };
        if (d.name) usedTools.push(d.name);
        toolEvents.push({
          id: d.id ?? `call-${toolEvents.length}`,
          phase: "call",
          name: d.name ?? "",
          payload: d.arguments,
        });
      } else if (chunk.type === "tool_result") {
        const d = chunk.data as { id?: string; name?: string; result?: unknown };
        toolEvents.push({
          id: d.id ?? `result-${toolEvents.length}`,
          phase: "result",
          name: d.name ?? "",
          payload: d.result,
        });
      }
      // Mirror chunks into the run registry so a client that drops mid-stream
      // (common on mobile when the OS suspends the tab) can reattach via SSE
      // GET /api/v1/threads/{id}/run and replay the buffered events. Without
      // this the WS path is "fire and forget to one socket" — any drop loses
      // everything the user hadn't seen yet.
      broadcast(req.thread_id, chunk);
      if (shouldEmitChunk(chunk.type, req.stream_options)) {
        sendJson(ws, { type: chunk.type, ...chunk.data });
      }
      if (chunk.type === "error") terminal = "error";
      if (chunk.type === "done" || chunk.type === "error") {
        break;
      }
    }
  } catch (err) {
    terminal = "error";
    const code = err instanceof RunThreadError ? err.code : "ws_stream_error";
    const message = err instanceof RunThreadError ? err.message : String(err);
    // Broadcast the terminal error so reattached SSE subscribers see it too,
    // then mirror it to the live WS (if still open).
    broadcast(req.thread_id, { type: "error", data: { message, code } });
    sendJson(ws, { type: "error", message, code });
  } finally {
    clearInterval(keepalive);
    persistAssistantMessage(req.thread_id, assistantContent, usedTools, toolEvents);
    finishRun(req.thread_id, terminal);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "completed");
    }
  }
}

function parseRunRequest(raw: string): WsRunRequest {
  const parsed = JSON.parse(raw) as Partial<WsRunRequest>;
  return {
    thread_id: String(parsed.thread_id ?? ""),
    message: String(parsed.message ?? ""),
    stream_options: parsed.stream_options,
  };
}

export function ensureWsServer(): { port: number } {
  if (globalThis.__jarelaWsState) {
    return { port: globalThis.__jarelaWsState.port };
  }

  const preferredPort = Number(process.env.JARELA_WS_PORT ?? 3219);
  const server = new WebSocketServer({
    port: preferredPort,
    // Same access policy as HTTP middleware — loopback or whitelisted Tailscale
    // identity. The actual TCP source IP is available here, so we use it
    // directly (more reliable than the spoofable Host header).
    verifyClient: (info, cb) => {
      // CSRF / cross-origin defense for the WS handshake. Browsers send the
      // Origin header reflecting the page that opened the WebSocket; if it
      // doesn't match Host, the open came from a malicious tab/site and we
      // refuse. Non-browser callers omit Origin and are gated by the
      // loopback/identity check below.
      const originHeader = info.req.headers.origin;
      const hostHeader = info.req.headers.host;
      if (originHeader && hostHeader) {
        try {
          if (new URL(originHeader).host !== hostHeader) {
            cb(false, 403, "Cross-origin WebSocket rejected");
            return;
          }
        } catch {
          cb(false, 403, "Malformed Origin");
          return;
        }
      }

      const result = requireAccess({
        headers: info.req.headers,
        host: info.req.headers.host ?? null,
        remoteAddress: info.req.socket.remoteAddress ?? null,
      });
      if (result.allowed) {
        (info.req as unknown as { __identity?: string | null }).__identity = result.identity;
        cb(true);
      } else {
        cb(false, 401, "Unauthorized");
      }
    },
  });

  // Reap broken connections: send ws-level ping every PING_INTERVAL_MS,
  // terminate any client that didn't pong since the previous tick. This
  // is the standard `ws` recipe for surviving silent TCP path failures
  // — the kind that happen when the user's laptop switches networks or
  // a VPN attaches/detaches mid-stream.
  const sweepInterval = setInterval(() => {
    for (const client of server.clients) {
      const ws = client as AliveSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, PING_INTERVAL_MS);
  server.on("close", () => clearInterval(sweepInterval));

  server.on("connection", (ws) => {
    const alive = ws as AliveSocket;
    alive.isAlive = true;
    ws.on("pong", () => { alive.isAlive = true; });

    sendJson(ws, { type: "ready" });

    let started = false;
    ws.on("message", async (msg) => {
      if (started) {
        sendJson(ws, { type: "error", message: "Only one run per websocket connection", code: "single_run_only" });
        return;
      }
      started = true;

      try {
        const req = parseRunRequest(msg.toString());
        await runAndStream(ws, req);
      } catch (err) {
        sendJson(ws, { type: "error", message: String(err), code: "invalid_ws_payload" });
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1003, "invalid payload");
        }
      }
    });
  });

  globalThis.__jarelaWsState = { server, port: preferredPort };
  return { port: preferredPort };
}
