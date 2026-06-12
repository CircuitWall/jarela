import { handleBrowserPoll } from "@/lib/api/browser-control";

/**
 * @public-internal — browser extension long-polls this for pending
 * navigation/click/extract commands enqueued by the agent. Loopback only.
 */
export async function POST(req: Request) {
  return handleBrowserPoll(req);
}

export async function GET(req: Request) {
  return handleBrowserPoll(req);
}
