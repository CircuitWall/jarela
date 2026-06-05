/**
 * @public — `GET /api/v1/threads` (list), `POST /api/v1/threads` (create)
 *
 * Thread lifecycle. Threads are the unit of conversation history; every
 * agent run lives inside one. See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { createThread, listThreads } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { errorResponse, notFoundResponse, createdResponse } from "@/lib/api/responses";

export function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  return NextResponse.json(listThreads(limit, offset));
}

export async function POST(req: NextRequest) {
  const { agent_id, title } = await req.json() as { agent_id: string; title?: string };
  if (!agent_id) return errorResponse("agent_id required");
  if (!getAgentConfig(agent_id)) return notFoundResponse(`Agent "${agent_id}" not found`);
  const thread = createThread(agent_id, title);
  return createdResponse(thread);
}
