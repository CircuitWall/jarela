import { NextRequest, NextResponse } from "next/server";
import { memoryValueSchema } from "@/api/memory";
import { deleteMemory, putMemory } from "@/lib/stores/memory";
import { errorResponse, validateBody } from "@/lib/api/responses";
import { isSkillExecutionPolicySetting } from "@/lib/skills/execution-policy";
import { isAdvertisementMemory } from "@/lib/agents/advertisement-contract";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ namespace: string; key: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  if (isAdvertisementMemory(namespace, key)) return errorResponse("Use agent advertisement settings", 403);
  if (isSkillExecutionPolicySetting(namespace, key)) return errorResponse("Use Security settings to change skill execution policy", 403);
  const body = await validateBody(req, memoryValueSchema);
  if (body instanceof NextResponse) return body;
  const r = putMemory(namespace, key, body.value);
  return NextResponse.json({ ...r, value: body.value });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  if (isAdvertisementMemory(namespace, key)) return errorResponse("Use agent advertisement settings", 403);
  if (isSkillExecutionPolicySetting(namespace, key)) return errorResponse("Use Security settings to change skill execution policy", 403);
  const deleted = deleteMemory(namespace, key);
  if (!deleted) return errorResponse(NOT_FOUND_ERRORS.DEFAULT, 404);
  return NextResponse.json({ deleted: true });
}
