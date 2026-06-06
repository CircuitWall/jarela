import { handleExtensionAgents } from "@/lib/api/extension-turn";

/**
 * @public-internal — browser-extension agent listing.
 */
export async function GET() {
  return handleExtensionAgents();
}
