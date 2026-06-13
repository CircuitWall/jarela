import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, validateBody } from "@/lib/api/responses";
import {
  beginInstall,
  listPendingInstalls,
} from "@/lib/tools/package-install";
import { errorMessage } from "@/lib/utils/error";

const InstallSchema = z.object({
  spec: z.string().min(1, "spec is required"),
  version: z.string().min(1).optional(),
});

export function GET() {
  return NextResponse.json(listPendingInstalls());
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, InstallSchema);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const outcome = await beginInstall(parsed);
    if (outcome.status === "pending") {
      return NextResponse.json(
        {
          status: "pending",
          approvalId: outcome.pending.id,
          publisher: outcome.pending.publisher,
          spec: outcome.pending.spec,
          reason: outcome.pending.reason,
        },
        { status: 202 },
      );
    }
    return NextResponse.json({ status: "installed", ...outcome.result });
  } catch (err) {
    return errorResponse(errorMessage(err), 500);
  }
}
