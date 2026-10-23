/**
 * @public — `POST /api/v1/agents/[id]/duplicate`
 *
 * Copy an agent's configuration into a new agent (optionally renamed) so a
 * tuned setup can be reused as a personal template. See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { duplicateAgentConfig } from "@/lib/stores/agent-configs";
import { agentToResponse } from "@/lib/api/serializers";
import { createdResponse, errorResponse, notFoundResponse } from "@/lib/api/responses";

type Params = { params: Promise<{ id: string }> };

const DuplicateBody = z.object({
  name: z.string().trim().min(1, "name must not be blank").max(200).optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return errorResponse("Request body must be valid JSON", 400);
    }
  }
  const parsed = DuplicateBody.safeParse(raw);
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "invalid body", 400);

  const row = duplicateAgentConfig(id, parsed.data.name);
  if (!row) return notFoundResponse("Agent not found");
  return createdResponse(agentToResponse(row));
}
