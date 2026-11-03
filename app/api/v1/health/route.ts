/**
 * @public — `GET /api/v1/health`
 *
 * Runtime readiness diagnostics. Fast process liveness is available at
 * `/api/v1/health/liveness`.
 */

import { NextResponse } from "next/server";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { DB_PATH, getDb } from "@/lib/db";
import { getMasterKeySource } from "@/lib/crypto/master-key";
import { isLoopbackRequest } from "@/lib/auth/access";

export function GET(req: Request) {
  getDb();
  const body: Record<string, unknown> = {
    status: "ok",
    agents: listAgentConfigs().map((agent) => agent.id),
    crypto: { source: getMasterKeySource() },
  };
  if (isLoopbackRequest(req)) body.db_path = DB_PATH;
  return NextResponse.json(body);
}
