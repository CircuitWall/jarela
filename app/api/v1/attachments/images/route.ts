import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { spillImagePart } from "@/lib/attachments/spill";
import { errorResponse, validateBody } from "@/lib/api/responses";

const ImageBody = z.object({
  media_type: z.string().regex(/^image\//, "media_type must be an image MIME type"),
  data: z.string().min(1, "data is required"),
});

// POST /api/v1/attachments/images
// Stores one inline base64 image and returns the lightweight image_ref used
// by thread messages. The chat client calls this as a preflight when a run
// payload would otherwise exceed Next's per-request body warning threshold.
export async function POST(req: NextRequest) {
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