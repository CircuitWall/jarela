import { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { ContributionCreateInput, contributionService } from "@/lib/workflows/contribution-service";

const agentId = z.string().min(1).max(200);
const operation = { agentId, operation_id: z.uuid() };
const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), agentId, workspace: z.string().min(1).max(4096), input: ContributionCreateInput }),
  z.strictObject({ action: z.literal("commit"), ...operation }),
  z.strictObject({ action: z.literal("push"), ...operation }),
  z.strictObject({ action: z.literal("draft_pr"), ...operation }),
]);
export async function POST(req: NextRequest) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 65536) return errorResponse("Contribution input exceeds 64 KiB", 400);
    const body = bodySchema.parse(JSON.parse(text));
    const service = contributionService();
    switch (body.action) {
      case "create": return noStoreJson(await service.start(body.agentId, body.workspace, body.input));
      case "commit": return noStoreJson(await service.requestCommit(body.operation_id, body.agentId));
      case "push": return noStoreJson(await service.requestPush(body.operation_id, body.agentId));
      case "draft_pr": return noStoreJson(await service.requestDraftPr(body.operation_id, body.agentId));
    }
  } catch (error) {
    console.warn("[contribution-authoring] request refused", error instanceof z.ZodError || error instanceof SyntaxError
      ? "Invalid contribution fields" : error instanceof Error ? error.message : "unknown failure");
    return errorResponse(error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid contribution fields" : "Contribution repository, policy or stage prerequisites refused", 400);
  }
}
export async function GET(req: NextRequest) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  const id = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
  const owner = agentId.safeParse(req.nextUrl.searchParams.get("agentId"));
  if (!id.success || !owner.success) return errorResponse("Operation id and agentId are required", 400);
  try { return noStoreJson(contributionService().inspectOperation(id.data, owner.data)); }
  catch { return errorResponse("Contribution operation unavailable", 404); }
}
