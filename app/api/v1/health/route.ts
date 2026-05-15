import { NextResponse } from "next/server";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { DB_PATH } from "@/lib/db";

export function GET() {
  return NextResponse.json({
    status: "ok",
    db_path: DB_PATH,
    agents: listAgentConfigs().map((a) => a.id),
  });
}
