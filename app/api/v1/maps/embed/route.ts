import { NextRequest, NextResponse } from "next/server";
import { getMcpServer, type McpStdioSpec } from "@/lib/stores/mcp-servers";

// Server-side proxy that builds a Google Maps Embed API URL with the user's
// API key injected. Keeps the key out of the client / out of message HTML.
//
// Key resolution order:
//   1. process.env.GOOGLE_MAPS_API_KEY (preferred — explicit)
//   2. google-maps MCP server spec.env.GOOGLE_MAPS_API_KEY (re-use existing config)
//
// Accepted query params (mirror Google's Embed API modes):
//   q=...                       -> /place?q=...
//   center=lat,lng & zoom=...   -> /view?center=...&zoom=...
//   origin=... & destination=...-> /directions?...
//   search=...                  -> /search?q=...
//
// If no key is available we 200 with a tiny HTML stub that links out to
// maps.google.com instead of leaking the failure as a broken iframe.

function resolveApiKey(): string | null {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  const row = getMcpServer("google-maps");
  if (!row || row.transport !== "stdio") return null;
  try {
    const spec = JSON.parse(row.spec) as McpStdioSpec;
    const k = spec.env?.GOOGLE_MAPS_API_KEY;
    return typeof k === "string" && k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

function buildEmbedUrl(params: URLSearchParams, key: string): string | null {
  const q = params.get("q");
  const center = params.get("center");
  const zoom = params.get("zoom");
  const origin = params.get("origin");
  const destination = params.get("destination");
  const search = params.get("search");

  const u = new URL("https://www.google.com/maps/embed/v1/place");
  u.searchParams.set("key", key);

  if (origin && destination) {
    u.pathname = "/maps/embed/v1/directions";
    u.searchParams.set("origin", origin);
    u.searchParams.set("destination", destination);
    const mode = params.get("mode");
    if (mode) u.searchParams.set("mode", mode);
  } else if (search) {
    u.pathname = "/maps/embed/v1/search";
    u.searchParams.set("q", search);
  } else if (q) {
    u.pathname = "/maps/embed/v1/place";
    u.searchParams.set("q", q);
  } else if (center) {
    u.pathname = "/maps/embed/v1/view";
    u.searchParams.set("center", center);
    u.searchParams.set("zoom", zoom ?? "13");
  } else {
    return null;
  }
  if (zoom && u.pathname !== "/maps/embed/v1/view") u.searchParams.set("zoom", zoom);
  return u.toString();
}

function fallbackHtml(message: string, linkHref: string | null): string {
  const link = linkHref
    ? `<a href="${linkHref}" target="_blank" rel="noreferrer">Open in Google Maps</a>`
    : "";
  return `<!doctype html><html><body style="margin:0;font:13px system-ui;color:#aaa;background:#111;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:8px"><div>${message}</div>${link}</body></html>`;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const key = resolveApiKey();

  if (!key) {
    // No key — render a friendly fallback with a regular maps.google.com link.
    const q = params.get("q") ?? params.get("search") ?? params.get("center") ?? "";
    const fallback = q
      ? `https://www.google.com/maps?q=${encodeURIComponent(q)}`
      : "https://www.google.com/maps";
    return new NextResponse(
      fallbackHtml("Google Maps API key not configured", fallback),
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const target = buildEmbedUrl(params, key);
  if (!target) {
    return new NextResponse(
      fallbackHtml("Missing map parameters (need q, center, search, or origin+destination)", null),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  // 302 redirect — the iframe will follow it and render the actual map.
  return NextResponse.redirect(target, 302);
}
