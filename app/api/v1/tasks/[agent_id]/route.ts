import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteTaskAssignment, upsertTaskAssignment } from "@/lib/stores/task-assignments";
import { validateBody } from "@/lib/api/responses";
import type { ToolPolicy } from "@/api/types";

type Params = { params: Promise<{ agent_id: string }> };

const PutBody = z.object({
  model_config_name: z.string().min(1, "model_config_name required"),
  tool_policy: z
    .object({
      allow: z.array(z.unknown()).optional(),
      deny: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const { agent_id } = await params;
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;

  const normalized: ToolPolicy | undefined = body.tool_policy
    ? {
        ...(Array.isArray(body.tool_policy.allow)
          ? { allow: body.tool_policy.allow.map((v) => String(v).trim()).filter(Boolean) }
          : {}),
        ...(Array.isArray(body.tool_policy.deny)
          ? { deny: body.tool_policy.deny.map((v) => String(v).trim()).filter(Boolean) }
          : {}),
      }
    : undefined;

  return NextResponse.json(upsertTaskAssignment(agent_id, body.model_config_name, normalized));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { agent_id } = await params;
  const deleted = deleteTaskAssignment(agent_id);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
