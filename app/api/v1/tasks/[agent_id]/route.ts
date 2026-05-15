import { NextRequest, NextResponse } from "next/server";
import { deleteTaskAssignment, upsertTaskAssignment } from "@/lib/stores/task-assignments";
import type { ToolPolicy } from "@/api/types";

type Params = { params: Promise<{ agent_id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const { agent_id } = await params;
  const { model_config_name, tool_policy } = await req.json() as { model_config_name: string; tool_policy?: ToolPolicy };
  if (!model_config_name) return NextResponse.json({ error: "model_config_name required" }, { status: 400 });

  const normalized: ToolPolicy | undefined = tool_policy
    ? {
        ...(Array.isArray(tool_policy.allow)
          ? { allow: tool_policy.allow.map((v) => String(v).trim()).filter(Boolean) }
          : {}),
        ...(Array.isArray(tool_policy.deny)
          ? { deny: tool_policy.deny.map((v) => String(v).trim()).filter(Boolean) }
          : {}),
      }
    : undefined;

  return NextResponse.json(upsertTaskAssignment(agent_id, model_config_name, normalized));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { agent_id } = await params;
  const deleted = deleteTaskAssignment(agent_id);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
