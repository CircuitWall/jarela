import { NextRequest } from "next/server";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { inspectWorkflowAuthorization } from "@/lib/workflows/authorization";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try { return noStoreJson(inspectWorkflowAuthorization((await context.params).id)); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : "Workflow plan unavailable", 404); }
}
