import { NextRequest, NextResponse } from "next/server";
import { listScheduledTasks } from "@/lib/stores/scheduled-tasks";

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agent_id = url.searchParams.get("agent_id") ?? undefined;
  const rows = listScheduledTasks(agent_id);
  return NextResponse.json(rows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id,
    prompt: r.prompt,
    description: r.description,
    kind: r.kind,
    schedule: r.schedule,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    last_error: r.last_error,
    enabled: r.enabled === 1,
    silent: r.silent === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  })));
}
