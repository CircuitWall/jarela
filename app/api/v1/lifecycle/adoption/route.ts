import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody } from "@/lib/api/responses";
import {
  getVersionAdoptionState,
  updateVersionAdoptionState,
} from "@/lib/stores/version-adoption";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["start", "mark_done", "dismiss", "retry"]),
});

export function GET() {
  return NextResponse.json(getVersionAdoptionState());
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, Body);
  if (body instanceof NextResponse) return body;
  return NextResponse.json(updateVersionAdoptionState(body.action));
}
