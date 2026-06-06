import { handleGenericExtensionTurn } from "@/lib/api/extension-turn";

/**
 * @public-internal — browser-extension generic turn request.
 */
export async function POST(req: Request) {
  return handleGenericExtensionTurn(req);
}
