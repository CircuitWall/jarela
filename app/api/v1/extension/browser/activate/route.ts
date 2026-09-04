import { handleBrowserActivate } from "@/lib/api/browser-control";

/**
 * @public-internal — asks the local browser extension to focus a tab by id.
 * This changes browser focus, but does not read or mutate page contents.
 * Loopback only.
 */
export async function POST(req: Request) {
  return handleBrowserActivate(req);
}
