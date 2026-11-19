import { listLatestAssistantRepliesByAgent } from "@/lib/stores/threads";
import { noStoreJson } from "@/lib/api/responses";

export async function GET() {
  return noStoreJson(await listLatestAssistantRepliesByAgent());
}