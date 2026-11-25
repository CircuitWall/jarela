/**
 * @public — `GET /api/v1/agents/recent-replies`
 *
 * Latest assistant reply per agent, used by the dashboard and agent cards.
 */
import { listLatestAssistantRepliesByAgent } from "@/lib/stores/threads";
import { noStoreJson } from "@/lib/api/responses";

export async function GET() {
  return noStoreJson(await listLatestAssistantRepliesByAgent());
}