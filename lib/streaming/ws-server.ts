import { WebSocket, WebSocketServer } from "ws";
import type { StreamOptions } from "@/lib/agents/base";
import {
  prepareThreadRun,
  persistAssistantMessage,
  RunThreadError,
  shouldEmitChunk,
} from "@/lib/agents/run-thread";
import { startRun, finishRun, getRun } from "@/lib/agents/run-registry";
import { getThread } from "@/lib/stores/threads";
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
  // eslint-disable-next-line no-var
  var __langguiWsState: WsServerState | undefined;
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function runAndStream(ws: WebSocket, req: WsRunRequest): Promise<void> {
  let assistantContent = "";
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
      }
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
    if (err instanceof RunThreadError) {
      sendJson(ws, { type: "error", message: err.message, code: err.code });
    } else {
      sendJson(ws, { type: "error", message: String(err), code: "ws_stream_error" });
    }
  } finally {
    persistAssistantMessage(req.thread_id, assistantContent);
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
  if (globalThis.__langguiWsState) {
    return { port: globalThis.__langguiWsState.port };
  }

  const preferredPort = Number(process.env.LANGGUI_WS_PORT ?? 3219);
  const server = new WebSocketServer({
    port: preferredPort,
    // Same access policy as HTTP middleware — loopback or whitelisted Tailscale
    // identity. The actual TCP source IP is available here, so we use it
    // directly (more reliable than the spoofable Host header).
    verifyClient: (info, cb) => {
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

  server.on("connection", (ws) => {
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

  globalThis.__langguiWsState = { server, port: preferredPort };
  return { port: preferredPort };
}
