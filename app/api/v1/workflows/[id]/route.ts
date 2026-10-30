import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { noStoreJson, validateBody } from "@/lib/api/responses";
import { getWorkflowService } from "@/lib/workflows/service";
import { guardWorkflowRequest, WorkflowItemQuery, WorkflowMutationBody, workflowError } from "@/lib/workflows/http";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const refused = guardWorkflowRequest(req);
  if (refused) return refused;
  try {
    const id = z.string().uuid().parse((await params).id);
    const { agentId } = WorkflowItemQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
    return noStoreJson(getWorkflowService().inspect(agentId, id));
  } catch (error) { return workflowError(error); }
}

export async function POST(req: NextRequest, { params }: Params) {
  const refused = guardWorkflowRequest(req);
  if (refused) return refused;
  const body = await validateBody(req, WorkflowMutationBody);
  if (body instanceof NextResponse) return body;
  try {
    const id = z.string().uuid().parse((await params).id);
    const service = getWorkflowService();
    switch (body.action) {
      case "advance": return noStoreJson(await service.advance(body.agentId, id, body.version, req.signal));
      case "answer": return noStoreJson(await service.answer(body.agentId, id, body));
      case "cancel": return noStoreJson(await service.cancel(body.agentId, id, body.version));
      case "reconcile": return noStoreJson(await service.reconcile(body.agentId, id, body.version, req.signal));
    }
  } catch (error) { return workflowError(error); }
}
