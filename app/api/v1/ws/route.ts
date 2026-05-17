import { NextRequest, NextResponse } from "next/server";
import { ensureWsServer } from "@/lib/streaming/ws-server";

export const runtime = "nodejs";

// Path that `tailscale serve` proxies to the WS sidecar when Jarela is
// fronted by tailscale. Configure with:
//   tailscale serve --bg --set-path=/__jarela_ws__ http://127.0.0.1:3219
// When the request arrives over loopback (the host machine's browser), we
// keep the direct `ws://localhost:<port>` URL because no proxy is in the way.
const TAILSCALE_WS_PATH = "/__jarela_ws__";
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/;

export async function GET(req: NextRequest) {
  const { port } = ensureWsServer();

  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto ?? (req.nextUrl.protocol.replace(":", "") || "http");
  const wsProto = proto === "https" ? "wss" : "ws";

  const hostHeader = req.headers.get("host") ?? "localhost:3000";
  const hostname = hostHeader.split(":")[0] || "localhost";

  // Loopback path: connect straight to the sidecar port — no proxy is
  // between the browser and the node process, and exposing it on a numeric
  // port is fine because nothing routes there from outside.
  // Non-loopback path (tailscale serve / funnel): the sidecar port is not
  // exposed; the only way in is the same TLS endpoint that served this
  // request, on a dedicated path that tailscale proxies to the sidecar.
  const url = LOOPBACK_HOST.test(hostHeader)
    ? `${wsProto}://${hostname}:${port}`
    : `${wsProto}://${hostHeader}${TAILSCALE_WS_PATH}`;

  return NextResponse.json({
    url,
    transport: "ws-sidecar",
  });
}
