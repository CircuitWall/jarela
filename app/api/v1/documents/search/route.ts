import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { searchDocuments } from "@/lib/documents/search";

const QuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(25).optional(),
  source_id: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q"),
    limit: url.searchParams.get("limit") ?? undefined,
    source_id: url.searchParams.get("source_id") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const hits = await searchDocuments(parsed.data.q, {
    limit: parsed.data.limit,
    sourceId: parsed.data.source_id,
  });
  return NextResponse.json({ query: parsed.data.q, hits });
}
