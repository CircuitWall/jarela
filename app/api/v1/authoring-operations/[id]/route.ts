import { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { AuthoringOperationType, cancelAuthoringOperation, inspectAuthoringOperation } from "@/lib/workflows/authoring-operations";

async function operation(req: NextRequest, context: { params: Promise<{ id: string }> }, cancel: boolean) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  const id = z.uuid().safeParse((await context.params).id);
  const type = AuthoringOperationType.safeParse(req.nextUrl.searchParams.get("type"));
  if (!id.success || !type.success) return errorResponse("Invalid operation identity or type", 400);
  try {
    return noStoreJson(cancel ? await cancelAuthoringOperation(id.data, type.data) : await inspectAuthoringOperation(id.data, type.data));
  } catch {
    return errorResponse("Authoring operation unavailable, expired or already terminal; inspect before retrying", 409);
  }
}
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) { return operation(req, context, false); }
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) { return operation(req, context, true); }
