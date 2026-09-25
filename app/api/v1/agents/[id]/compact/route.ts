import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { compactAgentThread } from "@/lib/agents/thread-compaction";

type Params = { params: Promise<{ id: string }> };
const Body = z.object({ reset_context: z.boolean().optional() });

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const agent = getAgentConfig(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "Invalid compaction request" }, { status: 400 });
  try {
    return NextResponse.json(await compactAgentThread(id, undefined, body.data.reset_context === true));
  } catch (err) {
    if (err instanceof Error && err.message === "No model configured") {
      return NextResponse.json({ error: "No model configured" }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Summarization failed: ${String(err)}`, code: "summarize_failed" },
      { status: 502 },
    );
  }
}
