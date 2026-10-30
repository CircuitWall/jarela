import { NextRequest, NextResponse } from "next/server";
import { noStoreJson, validateBody } from "@/lib/api/responses";
import { getWorkflowService } from "@/lib/workflows/service";
import { parseWorkflowDefinition } from "@/lib/workflows/definition";
import { validateSkillInvocation } from "@/lib/skills/execution-protocol";
import { guardWorkflowRequest, WorkflowCreateBody, WorkflowListQuery, workflowError } from "@/lib/workflows/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = guardWorkflowRequest(req);
  if (refused) return refused;
  try {
    const query = WorkflowListQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
    return noStoreJson(getWorkflowService().list(query.agentId, query.limit, query.after));
  } catch (error) { return workflowError(error); }
}

export async function POST(req: NextRequest) {
  const refused = guardWorkflowRequest(req);
  if (refused) return refused;
  const body = await validateBody(req, WorkflowCreateBody);
  if (body instanceof NextResponse) return body;
  try {
    const definition = parseWorkflowDefinition(body.definitionText);
    validateSkillInvocation(definition.inputContract, body.invocationJson);
    return noStoreJson(getWorkflowService().create(body.agentId, body.definitionText, body.invocationJson, body.workspace));
  } catch (error) { return workflowError(error); }
}
