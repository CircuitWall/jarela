import { NextRequest, NextResponse } from "next/server";
import { listScheduledTasks } from "@/lib/stores/scheduled-tasks";
import { rowResponse } from "./_response";

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agent_id = url.searchParams.get("agent_id") ?? undefined;
  return NextResponse.json(listScheduledTasks(agent_id).map(rowResponse));
}
