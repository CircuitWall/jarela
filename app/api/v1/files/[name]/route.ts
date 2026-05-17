import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
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
// ~/.jarela/files/. Path-traversal safe — names must match a strict regex.
//
// Notes:
// - We stream from disk (don't buffer the whole image into memory).
// - We include Last-Modified/ETag/Accept-Ranges so iOS Safari's image
//   decoder is happy — older code returned a bare Buffer with private
//   Cache-Control, which Safari sometimes rejected silently.
export async function GET(req: NextRequest, { params }: Params) {
  return serve(req, await params, "GET");
}

export async function HEAD(req: NextRequest, { params }: Params) {
  return serve(req, await params, "HEAD");
}

async function serve(req: NextRequest, { name }: { name: string }, method: "GET" | "HEAD") {
  const abs = fileAbsPath(name);
  if (!abs) return new NextResponse("invalid name", { status: 400 });
  let s;
  try {
    s = await stat(abs);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
  if (!s.isFile()) return new NextResponse("not found", { status: 404 });

  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const lastModified = new Date(s.mtimeMs).toUTCString();
  const etag = `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;

  // Conditional GET: return 304 if the client already has it.
  const ifNoneMatch = req.headers.get("if-none-match");
  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= s.mtimeMs - 1000)) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Last-Modified": lastModified } });
  }

  // Range request support — iOS Safari/QuickLook sometimes probes with a
  // Range header even for images, and gets confused when the server replies
  // with 200 + the full body instead of 206.
  const range = req.headers.get("range");
  let start = 0;
  let end = s.size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const a = m[1] ? Number(m[1]) : NaN;
      const b = m[2] ? Number(m[2]) : NaN;
      if (Number.isFinite(a) && Number.isFinite(b)) { start = a; end = b; }
      else if (Number.isFinite(a)) { start = a; }
      else if (Number.isFinite(b)) { start = Math.max(0, s.size - b); }
      if (start > end || end >= s.size) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${s.size}`, "Accept-Ranges": "bytes" },
        });
      }
      status = 206;
    }
  }

  const length = end - start + 1;
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Last-Modified": lastModified,
    ETag: etag,
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${s.size}`;

  if (method === "HEAD") {
    return new NextResponse(null, { status, headers });
  }

  const nodeStream = createReadStream(abs, { start, end });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(webStream, { status, headers });
}

