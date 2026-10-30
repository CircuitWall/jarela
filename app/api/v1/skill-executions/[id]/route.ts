import { NextRequest } from "next/server";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { skillExecutionService } from "@/lib/skills/execution-service";

type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try { return noStoreJson(skillExecutionService().inspect((await context.params).id)); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : "Execution request unavailable", 404); }
}
export async function DELETE(req: NextRequest, context: Context) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try {
    skillExecutionService().cancel((await context.params).id);
    return noStoreJson({ cancelled: true });
  } catch (error) { return errorResponse(error instanceof Error ? error.message : "Execution cancellation failed", 409); }
}
