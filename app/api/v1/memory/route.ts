import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listMemory, putMemory, searchMemoryRows } from "@/lib/stores/memory";
import { createdResponse, errorResponse, validateBody } from "@/lib/api/responses";
import { isSkillExecutionPolicySetting } from "@/lib/skills/execution-policy";
import { isAdvertisementMemory } from "@/lib/agents/advertisement-contract";
import { parseJsonSafe } from "@/lib/utils/json";

const PutBody = z.object({
  namespace: z.string().min(1, "namespace required"),
  key: z.string().min(1, "key required"),
  value: z.unknown(),
});

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const namespace = p.get("namespace") ?? undefined;
  if (namespace === "agent-advertisements") return errorResponse("Use agent advertisement settings", 403);
  const search = p.get("search") ?? undefined;
  const limit = Number(p.get("limit") ?? 50);
  const items = search ? await searchMemoryRows(namespace, search, limit) : listMemory(namespace, undefined, limit);
  return NextResponse.json(items.map((r) => ({ ...r, value: parseJsonSafe<unknown>(r.value, null) })));
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  if (isAdvertisementMemory(body.namespace, body.key)) return errorResponse("Use agent advertisement settings", 403);
  if (isSkillExecutionPolicySetting(body.namespace, body.key)) return errorResponse("Use Security settings to change skill execution policy", 403);
  const r = putMemory(body.namespace, body.key, body.value);
  return createdResponse({ ...r, value: body.value });
}
