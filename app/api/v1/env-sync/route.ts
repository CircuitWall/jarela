// Env-sync API. The DB-init hook in lib/db/index.ts already runs a
// silent apply once per process at boot — these endpoints exist so the
// Integrations panel can:
//
//   GET  → preview (non-mutating) what the next sync would write,
//          regardless of whether boot-sync already ran.
//   POST → apply now, e.g. after the user rotated a token in their
//          rc and wants the change to take effect without a restart.
//
// Both return a SyncResult with masked previews so the UI can show
// which env var is feeding which integration field, and which fields
// are skipped because the user has touched them in the panel.

import { NextResponse } from "next/server";
import { previewEnvSync, applyEnvSync } from "@/lib/env/sync";

export async function GET() {
  const r = await previewEnvSync();
  return NextResponse.json(r);
}

export async function POST() {
  const r = await applyEnvSync();
  return NextResponse.json(r);
}
