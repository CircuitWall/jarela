import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteScheduledTask, updateScheduledTask } from "@/lib/stores/scheduled-tasks";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { rowResponse } from "../_response";
import { errorResponse, notFoundResponse, validateBody } from "@/lib/api/responses";
import { errorMessage } from "@/lib/utils/error";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  agent_id: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  kind: z.enum(["once", "cron"]).optional(),
  schedule: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  silent: z.boolean().optional(),
  // ADR-0032 — discriminated reaction; mirrors the watcher PATCH schema.
  reaction_kind: z.enum(["agent_prompt", "script"]).optional(),
  reaction_script: z.string().nullable().optional(),
  reaction_script_args: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const parsed = await validateBody(req, PatchSchema);
  if (parsed instanceof NextResponse) return parsed;
  if (parsed.agent_id !== undefined && !getAgentConfig(parsed.agent_id)) {
    return errorResponse(`Agent "${parsed.agent_id}" not found`);
  }
  try {
    const updated = updateScheduledTask(id, parsed);
    if (!updated) return notFoundResponse();
    return NextResponse.json(rowResponse(updated));
  } catch (e) {
    return errorResponse(errorMessage(e));
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteScheduledTask(id);
  if (!ok) return notFoundResponse();
  return NextResponse.json({ deleted: true });
}
