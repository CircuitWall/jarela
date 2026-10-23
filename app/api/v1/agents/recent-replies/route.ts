import { listLatestAssistantRepliesByAgent } from "@/lib/stores/threads";
import { noStoreJson } from "@/lib/api/responses";

export function GET() {
  return noStoreJson(listLatestAssistantRepliesByAgent());
}