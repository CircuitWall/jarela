// Shared response builder for Server-Sent Event streams. Centralises the
// content-type / cache-control / connection / proxy-buffering headers so
// every SSE endpoint behaves identically through nginx, tailscale-serve,
// and Cloudflare. See ADR-0009 for the proxy story.

export interface SseResponseOptions {
  /**
   * Set `X-Accel-Buffering: no`. Required when intermediate proxies
   * (nginx, tailscale-serve) might coalesce small chunks and break SSE
   * framing. Default: true.
   */
  disableProxyBuffering?: boolean;
}

export function sseResponse(
  stream: ReadableStream,
  opts: SseResponseOptions = {},
): Response {
  const { disableProxyBuffering = true } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (disableProxyBuffering) headers["X-Accel-Buffering"] = "no";
  return new Response(stream, { headers });
}
