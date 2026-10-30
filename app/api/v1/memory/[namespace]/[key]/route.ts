import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteMemory, putMemory } from "@/lib/stores/memory";
import { errorResponse, validateBody } from "@/lib/api/responses";
import { isSkillExecutionPolicySetting } from "@/lib/skills/execution-policy";
import { isAdvertisementMemory } from "@/lib/agents/advertisement-contract";

type Params = { params: Promise<{ namespace: string; key: string }> };

const PutBody = z.object({ value: z.unknown() });

export async function PUT(req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  if (isAdvertisementMemory(namespace, key)) return errorResponse("Use agent advertisement settings", 403);
  if (isSkillExecutionPolicySetting(namespace, key)) return errorResponse("Use Security settings to change skill execution policy", 403);
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  const r = putMemory(namespace, key, body.value);
  return NextResponse.json({ ...r, value: body.value });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { namespace, key } = await params;
  if (isAdvertisementMemory(namespace, key)) return errorResponse("Use agent advertisement settings", 403);
  if (isSkillExecutionPolicySetting(namespace, key)) return errorResponse("Use Security settings to change skill execution policy", 403);
  const deleted = deleteMemory(namespace, key);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
