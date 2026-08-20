import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { compactAgentThread } from "@/lib/agents/thread-compaction";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const agent = getAgentConfig(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  try {
    return NextResponse.json(await compactAgentThread(id));
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
