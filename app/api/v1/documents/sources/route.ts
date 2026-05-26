import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  createDocumentSource,
  getDocumentSourceByPath,
  getDocumentSourceStats,
  listDocumentSources,
} from "@/lib/stores/document-sources";

const PostSchema = z.object({
  path: z.string().min(1),
  label: z.string().nullable().optional(),
});

export async function GET() {
  const sources = listDocumentSources();
  return NextResponse.json(
    sources.map((s) => ({
      id: s.id,
      path: s.path,
      label: s.label,
      enabled: s.enabled === 1,
      last_scan_at: s.last_scan_at,
      last_error: s.last_error,
      created_at: s.created_at,
      updated_at: s.updated_at,
      stats: getDocumentSourceStats(s.id),
    })),
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const abs = path.resolve(parsed.data.path);

  // Existence + directory check up front so the user gets immediate
  // feedback instead of a silent "no documents indexed" later.
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) {
      return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "path does not exist or is unreadable" }, { status: 400 });
  }

  if (getDocumentSourceByPath(abs)) {
    return NextResponse.json({ error: "source already exists for this path" }, { status: 409 });
  }

  const row = createDocumentSource({ path: abs, label: parsed.data.label ?? null });
  return NextResponse.json({
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled === 1,
    last_scan_at: row.last_scan_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stats: getDocumentSourceStats(row.id),
  }, { status: 201 });
}
