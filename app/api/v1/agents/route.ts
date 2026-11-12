/**
 * @public — `GET /api/v1/agents` (list), `POST /api/v1/agents` (upsert)
 *
 * Agent-config CRUD: identity, instructions, tool policy, model config.
 * See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  listAgentConfigs,
  upsertAgentConfig,
  generateAgentId,
} from "@/lib/stores/agent-configs";
import { agentToResponse } from "@/lib/api/serializers";
import { createdResponse, cachedJson, validateBody } from "@/lib/api/responses";
import { withServerTiming } from "@/lib/api/server-timing";
import type { AgentConfigIn } from "@/api/types";
import { toCreateAgentInput, WarmSummaryLimitSchema, UsageProfileSchema } from "./payload";

// Permissive schema: only enforce that `name` is a non-empty string at the
// boundary. The payload handler does field-by-field coercion for the rest,
// so additional unknown fields pass through unchanged via `.loose()`.
const CreateBody = z.looseObject({
  name: z.string().trim().min(1, "name is required"),
  warm_summary_limit: WarmSummaryLimitSchema,
  usage_profile: UsageProfileSchema,
});

export function GET() {
  const requestStarted = performance.now();
  const queryStarted = performance.now();
  const configs = listAgentConfigs();
  const queryMs = performance.now() - queryStarted;
  const serializationStarted = performance.now();
  const response = cachedJson(configs.map(agentToResponse), 15, 60);
  const responseMs = performance.now() - serializationStarted;
  return withServerTiming(response, [
    { name: "sql", durationMs: queryMs, description: "agent list query" },
    { name: "response", durationMs: responseMs, description: "mapping and JSON" },
    { name: "total", durationMs: performance.now() - requestStarted },
  ]);
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, CreateBody);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed as AgentConfigIn;

  const row = upsertAgentConfig(toCreateAgentInput(generateAgentId(body.name), body));

  return createdResponse(agentToResponse(row));
}
