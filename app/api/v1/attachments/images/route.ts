import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { spillImageBuffer, spillImagePart } from "@/lib/attachments/spill";
import { errorResponse, validateBody } from "@/lib/api/responses";

const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

const ImageBody = z.object({
  media_type: z.string().regex(/^image\//, "media_type must be an image MIME type"),
  data: z.string().min(1, "data is required"),
});

function imageMediaType(file: File): string | null {
  if (file.type.startsWith("image/")) return file.type;
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return ext ? (IMAGE_MIME_BY_EXT[ext] ?? null) : null;
}

// POST /api/v1/attachments/images
// Stores one inline base64 image and returns the lightweight image_ref used
// by thread messages. The chat client calls this as a preflight when a run
// payload would otherwise exceed Next's per-request body warning threshold.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return errorResponse("file is required", 400);
      const mediaType = imageMediaType(file);
      if (!mediaType) return errorResponse("file must be an image", 400);
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) return errorResponse("image exceeds 50 MB", 413);

      const ref = await spillImageBuffer(Buffer.from(await file.arrayBuffer()), mediaType);
      return NextResponse.json(ref, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 400);
    }
  }

  const parsed = await validateBody(req, ImageBody);
  if (parsed instanceof NextResponse) return parsed;

  try {
    const ref = await spillImagePart({ type: "image", media_type: parsed.media_type, data: parsed.data });
    return NextResponse.json(ref, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, 400);
  }
}