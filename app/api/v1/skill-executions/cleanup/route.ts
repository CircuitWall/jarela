import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { cleanupAbandonedSkillStaging } from "@/lib/stores/skill-run-staging";

export function POST(req: Request) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try { return noStoreJson(cleanupAbandonedSkillStaging()); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : "Staging cleanup failed", 500); }
}
