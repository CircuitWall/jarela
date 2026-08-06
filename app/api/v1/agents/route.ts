/**
 * @public — `GET /api/v1/agents` (list), `POST /api/v1/agents` (upsert)
 *
 * Agent-config CRUD: identity, instructions, tool policy, model config.
 * See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listAgentConfigs,
  upsertAgentConfig,
  generateAgentId,
} from "@/lib/stores/agent-configs";
import { agentToResponse } from "@/lib/api/serializers";
import { createdResponse, cachedJson, validateBody } from "@/lib/api/responses";
import type { AgentConfigIn } from "@/api/types";
import { toCreateAgentInput } from "./payload";

// Permissive schema: only enforce that `name` is a non-empty string at the
// boundary. The payload handler does field-by-field coercion for the rest,
// so additional unknown fields pass through unchanged via `.loose()`.
const CreateBody = z.looseObject({
  name: z.string().trim().min(1, "name is required"),
});

export function GET() {
  return cachedJson(listAgentConfigs().map(agentToResponse), 15, 60);
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, CreateBody);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed as AgentConfigIn;

  const row = upsertAgentConfig(toCreateAgentInput(generateAgentId(body.name), body));

  return createdResponse(agentToResponse(row));
}
