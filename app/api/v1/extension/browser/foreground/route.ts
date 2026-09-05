import { handleBrowserForeground } from "@/lib/api/browser-control";

/**
 * @public-internal — ambient surroundings ingest for the local browser
 * extension (ADR-0082). POST records the page the user is looking at while
 * the side panel is open; DELETE retracts it. Metadata only, loopback only.
 */
export async function POST(req: Request) {
  return handleBrowserForeground(req);
}

export async function DELETE(req: Request) {
  return handleBrowserForeground(req);
}
