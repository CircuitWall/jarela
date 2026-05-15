import { NextRequest, NextResponse } from "next/server";
import { ensureWsServer } from "@/lib/streaming/ws-server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { port } = ensureWsServer();

  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto ?? (req.nextUrl.protocol.replace(":", "") || "http");
  const wsProto = proto === "https" ? "wss" : "ws";

  const hostHeader = req.headers.get("host") ?? "localhost:3000";
  const hostname = hostHeader.split(":")[0] || "localhost";

  return NextResponse.json({
    url: `${wsProto}://${hostname}:${port}`,
    transport: "ws-sidecar",
  });
}
