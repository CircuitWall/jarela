import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultChatMinSimilarity, searchMemory } from "@/lib/embeddings";

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(1_000),
  source: z.enum(["all", "memory", "messages"]).default("all"),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  min_similarity: z.coerce.number().min(0).max(1).optional(),
  min_chat_similarity: z.coerce.number().min(0).max(1).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse({
    q: req.nextUrl.searchParams.get("q"),
    source: req.nextUrl.searchParams.get("source") ?? undefined,
    limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    min_similarity: req.nextUrl.searchParams.get("min_similarity") ?? undefined,
    min_chat_similarity: req.nextUrl.searchParams.get("min_chat_similarity") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }

  const { q, source, limit, min_similarity, min_chat_similarity } = parsed.data;
  const hits = await searchMemory(q, {
    sources: source,
    limit,
    literal: true,
    minSimilarity: min_similarity,
    minMessageSimilarity: min_chat_similarity ?? (source === "messages" ? getDefaultChatMinSimilarity() : undefined),
  });
  return NextResponse.json({
    query: q,
    source,
    hits,
    min_chat_similarity: min_chat_similarity ?? (source === "messages" ? getDefaultChatMinSimilarity() : null),
  });
}