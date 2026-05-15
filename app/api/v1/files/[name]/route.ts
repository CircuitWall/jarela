import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { fileAbsPath } from "@/lib/files";

type Params = { params: Promise<{ name: string }> };

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

// GET /api/v1/files/[name]
// Serves a file produced by a tool (e.g. generate_image) from
// ~/.langgui/files/. Path-traversal safe — names must match a strict regex.
export async function GET(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const abs = fileAbsPath(name);
  if (!abs) return new NextResponse("invalid name", { status: 400 });
  try {
    const s = await stat(abs);
    if (!s.isFile()) return new NextResponse("not found", { status: 404 });
    const data = await readFile(abs);
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(s.size),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
