import { handleExtensionTurn } from "@/lib/api/extension-turn";

/**
 * @public-internal — browser-extension fill request.
 */
export async function POST(req: Request) {
  return handleExtensionTurn("fill", req);
}
