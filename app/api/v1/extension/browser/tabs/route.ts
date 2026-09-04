import { handleBrowserTabs } from "@/lib/api/browser-control";

/**
 * @public-internal — app-side tab inventory for the local browser extension.
 * Returns sanitized tab metadata only; page content stays behind explicit
 * browser_snapshot / browser_extract tools. Loopback only.
 */
export async function GET(req: Request) {
  return handleBrowserTabs(req);
}
