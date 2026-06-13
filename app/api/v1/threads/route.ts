/**
 * @public — `GET /api/v1/threads` (list), `POST /api/v1/threads` (create)
 *
 * Thread lifecycle. Threads are the unit of conversation history; every
 * agent run lives inside one. See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createThread, listThreads } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { notFoundResponse, createdResponse, validateBody } from "@/lib/api/responses";

const CreateBody = z.object({
  agent_id: z.string().min(1, "agent_id required"),
  title: z.string().optional(),
});

export function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  return NextResponse.json(listThreads(limit, offset));
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, CreateBody);
  if (body instanceof NextResponse) return body;
  if (!getAgentConfig(body.agent_id)) return notFoundResponse(`Agent "${body.agent_id}" not found`);
  const thread = createThread(body.agent_id, body.title);
  return createdResponse(thread);
}
