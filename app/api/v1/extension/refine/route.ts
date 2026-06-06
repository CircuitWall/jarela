import { handleExtensionTurn } from "@/lib/api/extension-turn";

/**
 * @public-internal — browser-extension refine request.
 */
export async function POST(req: Request) {
  return handleExtensionTurn("refine", req);
}
