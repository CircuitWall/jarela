import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody, errorResponse } from "@/lib/api/responses";
import {
  getVersionAdoptionState,
  updateVersionAdoptionState,
  VersionAdoptionRequestError,
} from "@/lib/stores/version-adoption";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["start", "mark_done", "dismiss", "retry"]),
  item_id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
}).refine((body) => body.item_id === undefined || body.action === "retry", {
  message: "item_id is only valid with action retry",
  path: ["item_id"],
});

export function GET() {
  return NextResponse.json(getVersionAdoptionState());
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, Body);
  if (body instanceof NextResponse) return body;
  try {
    return NextResponse.json(updateVersionAdoptionState(body.action, undefined, body.item_id));
  } catch (err) {
    if (err instanceof VersionAdoptionRequestError) {
      return errorResponse(err.message, 400);
    }
    throw err;
  }
}