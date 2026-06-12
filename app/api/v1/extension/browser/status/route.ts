import { handleBrowserStatus } from "@/lib/api/browser-control";

/**
 * @public-internal — agent-side connectivity probe. Returns whether the
 * browser extension is currently long-polling, how long ago we last
 * heard from it, and how many commands are pending in the queue.
 *
 * Used by the browser-control tools to fail fast with a clear error
 * when the extension is offline, instead of waiting the full per-command
 * timeout. Loopback only.
 */
export async function GET(req: Request) {
  return handleBrowserStatus(req);
}
