import { NextRequest, NextResponse } from "next/server";
import { listMemory, putMemory } from "@/lib/stores/memory";

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const items = listMemory(p.get("namespace") ?? undefined, p.get("search") ?? undefined, Number(p.get("limit") ?? 50));
  return NextResponse.json(items.map((r) => ({ ...r, value: JSON.parse(r.value) })));
}

export async function POST(req: NextRequest) {
  const { namespace, key, value } = await req.json() as { namespace: string; key: string; value: unknown };
  if (!namespace || !key) return NextResponse.json({ error: "namespace and key required" }, { status: 400 });
  const r = putMemory(namespace, key, value);
  return NextResponse.json({ ...r, value }, { status: 201 });
}
