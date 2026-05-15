import { NextRequest, NextResponse } from "next/server";
import { createThread, listThreads } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";

export function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  return NextResponse.json(listThreads(limit, offset));
}

export async function POST(req: NextRequest) {
  const { agent_id, title } = await req.json() as { agent_id: string; title?: string };
  if (!agent_id) return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  if (!getAgentConfig(agent_id)) {
    return NextResponse.json({ error: `Agent "${agent_id}" not found` }, { status: 404 });
  }
  const thread = createThread(agent_id, title);
  return NextResponse.json(thread, { status: 201 });
}
