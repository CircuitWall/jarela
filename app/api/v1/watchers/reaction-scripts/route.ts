// ADR-0031 — list registered reaction scripts (`reaction.*` namespace).
// Used by the watcher UI's reaction picker. Internal scripts (e.g.
// documents.reindex_local_file) are filtered out by listReactionScripts.
import { NextResponse } from "next/server";
import { listReactionScripts } from "@/lib/triggers/scripts";

export function GET() {
  return NextResponse.json({ scripts: listReactionScripts() });
}
