import { handleBrowserHistory } from "@/lib/api/browser-control";

/**
 * @public-internal — sanitized browser command history for the app UI.
 * Contains metadata only, never raw page content, screenshots, cookies, or form values.
 * Loopback only.
 */
export async function GET(req: Request) {
  return handleBrowserHistory(req);
}
