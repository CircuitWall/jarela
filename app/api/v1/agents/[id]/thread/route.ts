import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!getAgentConfig(id)) {
    return errorResponse(NOT_FOUND_ERRORS.AGENT, 404);
  }
  const thread = getOrCreateAgentThread(id);
  return NextResponse.json({
    thread_id: thread.thread_id,
    agent_id: thread.agent_id,
    title: thread.title,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    message_count: thread.message_count,
  });
}
