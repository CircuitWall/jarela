import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, noStoreJson, validateBody } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { skillExecutionService } from "@/lib/skills/execution-service";

const requestSchema = z.strictObject({
  agent_id: z.string().min(1).max(240), skill_id: z.string().min(1).max(240),
  input_json: z.string().max(65536), workspace: z.string().min(1).max(4096),
});
export async function POST(req: NextRequest) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  const body = await validateBody(req, requestSchema);
  if (body instanceof NextResponse) return body;
  try {
    return noStoreJson(await skillExecutionService().request({
      agentId: body.agent_id, skillId: body.skill_id, inputJson: body.input_json, workspace: body.workspace,
    }));
  } catch (error) { return errorResponse(error instanceof Error ? error.message : "Skill execution request failed", 400); }
}
