import { cachedJson } from "@/lib/api/responses";
import { listProviderNames } from "@/lib/providers";

export async function GET() {
  return cachedJson(listProviderNames(), 300);
}
