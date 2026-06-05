/**
 * @public — `GET /api/v1/agents` (list), `POST /api/v1/agents` (upsert)
 *
 * Agent-config CRUD: identity, instructions, tool policy, model config.
 * See `docs/api.md`.
 */

import { NextRequest } from "next/server";
import {
  listAgentConfigs,
  upsertAgentConfig,
  generateAgentId,
} from "@/lib/stores/agent-configs";
import { agentToResponse } from "@/lib/api/serializers";
import { errorResponse, createdResponse, cachedJson } from "@/lib/api/responses";
import type { AgentConfigIn } from "@/api/types";
import { toCreateAgentInput } from "./payload";

export function GET() {
  return cachedJson(listAgentConfigs().map(agentToResponse), 15);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as AgentConfigIn;

  if (!body.name?.trim()) {
    return errorResponse("name is required");
  }

  const row = upsertAgentConfig(toCreateAgentInput(generateAgentId(body.name), body));

  return createdResponse(agentToResponse(row));
}
