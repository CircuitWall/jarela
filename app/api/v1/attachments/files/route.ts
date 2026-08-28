import { NextRequest, NextResponse } from "next/server";
import { spillFileBuffer } from "@/lib/attachments/spill";
import { errorResponse } from "@/lib/api/responses";

const MAX_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return errorResponse("Request body must be multipart/form-data", 400);
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("file is required", 400);
    if (file.size > MAX_FILE_UPLOAD_BYTES) return errorResponse("file exceeds 50 MB", 413);

    const mediaType = file.type || "application/octet-stream";
    const ref = await spillFileBuffer(Buffer.from(await file.arrayBuffer()), mediaType, file.name);
    return NextResponse.json(ref, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, 400);
  }
}