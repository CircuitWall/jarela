import { NextResponse } from "next/server";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { DB_PATH, getDb } from "@/lib/db";
import { getMasterKeySource } from "@/lib/crypto/master-key";

export function GET() {
  // Touch the DB so master-key bootstrap has definitely run by the time
  // we report its source. getDb() is idempotent.
  getDb();
  return NextResponse.json({
    status: "ok",
    db_path: DB_PATH,
    agents: listAgentConfigs().map((a) => a.id),
    crypto: { source: getMasterKeySource() },
  });
}
