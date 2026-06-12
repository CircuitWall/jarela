import { handleBrowserResult } from "@/lib/api/browser-control";

/**
 * @public-internal — browser extension posts the outcome of a previously
 * polled browser-control command. Loopback only.
 */
export async function POST(req: Request) {
  return handleBrowserResult(req);
}
