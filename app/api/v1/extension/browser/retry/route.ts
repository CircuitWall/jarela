import { handleBrowserRetry } from "@/lib/api/browser-control";

/**
 * @public-internal — retry a sanitized, retry-eligible browser command.
 * Commands that would require stored form values are intentionally not retryable.
 * Loopback only.
 */
export async function POST(req: Request) {
  return handleBrowserRetry(req);
}
