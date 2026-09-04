import { handleBrowserProgress } from "@/lib/api/browser-control";

/**
 * @public-internal — extension heartbeat/progress for an in-flight browser command.
 * Stores sanitized phase names only; no page contents or form values.
 * Loopback only.
 */
export async function POST(req: Request) {
  return handleBrowserProgress(req);
}
