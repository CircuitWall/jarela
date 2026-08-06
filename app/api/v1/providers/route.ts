/**
 * @public — `GET /api/v1/providers`
 *
 * Lists every registered LLM provider name (built-in + external `.cjs`
 * plugins). The agent-callable equivalent is the `list_providers` tool.
 * See `docs/api.md`.
 */

import { cachedJson } from "@/lib/api/responses";
import { listProviderNames } from "@/lib/providers";

export async function GET() {
  return cachedJson(listProviderNames(), 300, 600);
}
