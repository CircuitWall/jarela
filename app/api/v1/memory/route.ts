import { NextRequest, NextResponse } from "next/server";
import { listMemory, putMemory } from "@/lib/stores/memory";
import { errorResponse, createdResponse } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const items = listMemory(p.get("namespace") ?? undefined, p.get("search") ?? undefined, Number(p.get("limit") ?? 50));
  return NextResponse.json(items.map((r) => ({ ...r, value: parseJsonSafe<unknown>(r.value, null) })));
}

export async function POST(req: NextRequest) {
  const { namespace, key, value } = await req.json() as { namespace: string; key: string; value: unknown };
  if (!namespace || !key) return errorResponse("namespace and key required");
  const r = putMemory(namespace, key, value);
  return createdResponse({ ...r, value });
}
