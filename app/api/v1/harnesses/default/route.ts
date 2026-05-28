import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, validateBody } from "@/lib/api/responses";
import { getDefaultHarnessId, setDefaultHarnessId } from "@/lib/stores/harnesses";

const putSchema = z.object({
  id: z.string().min(1),
});

export function GET() {
  return NextResponse.json({ id: getDefaultHarnessId() });
}

export async function PUT(req: NextRequest) {
  const parsed = await validateBody(req, putSchema);
  if (parsed instanceof Response) return parsed;
  try {
    const id = setDefaultHarnessId(parsed.id);
    return NextResponse.json({ id });
  } catch (err) {
    return errorResponse((err as Error).message, 404);
  }
}
