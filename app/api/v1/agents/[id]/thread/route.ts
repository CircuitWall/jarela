import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";
import { withServerTiming } from "@/lib/api/server-timing";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const requestStarted = performance.now();
  const { id } = await params;
  const lookupStarted = performance.now();
  if (!getAgentConfig(id)) {
    return errorResponse(NOT_FOUND_ERRORS.AGENT, 404);
  }
  const thread = getOrCreateAgentThread(id);
  const lookupMs = performance.now() - lookupStarted;
  const responseStarted = performance.now();
  const response = NextResponse.json({
    thread_id: thread.thread_id,
    agent_id: thread.agent_id,
    title: thread.title,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    message_count: thread.message_count,
  });
  const responseMs = performance.now() - responseStarted;
  return withServerTiming(response, [
    { name: "lookup", durationMs: lookupMs, description: "agent and thread" },
    { name: "response", durationMs: responseMs, description: "JSON" },
    { name: "total", durationMs: performance.now() - requestStarted },
  ]);
}
