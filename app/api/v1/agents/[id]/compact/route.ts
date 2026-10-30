import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { compactAgentThread } from "@/lib/agents/thread-compaction";
import { errorResponse, errorJson } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ id: string }> };
const Body = z.object({ reset_context: z.boolean().optional() });

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const agent = getAgentConfig(id);
  if (!agent) return errorResponse(NOT_FOUND_ERRORS.AGENT, 404);
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return errorResponse("Invalid compaction request", 400);
  try {
    return NextResponse.json(await compactAgentThread(id, undefined, body.data.reset_context === true));
  } catch (err) {
    if (err instanceof Error && err.message === "No model configured") {
      return errorResponse("No model configured", 400);
    }
    return errorJson({ error: `Summarization failed: ${String(err)}`, code: "summarize_failed" }, { status: 502 });
  }
}
