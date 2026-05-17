import { NextResponse } from "next/server";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { DB_PATH, getDb } from "@/lib/db";
import { getMasterKeySource } from "@/lib/crypto/master-key";
import { isLoopbackRequest } from "@/lib/auth/access";

export function GET(req: Request) {
  // Touch the DB so master-key bootstrap has definitely run by the time
  // we report its source. getDb() is idempotent.
  getDb();
  // db_path leaks the host's filesystem layout. Only expose it to the
  // local user (loopback Host); tailnet clients see status only.
  const body: Record<string, unknown> = {
    status: "ok",
    agents: listAgentConfigs().map((a) => a.id),
    crypto: { source: getMasterKeySource() },
  };
  if (isLoopbackRequest(req)) {
    body.db_path = DB_PATH;
  }
  return NextResponse.json(body);
}
