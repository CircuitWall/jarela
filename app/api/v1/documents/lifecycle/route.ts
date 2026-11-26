import { NextRequest, NextResponse } from "next/server";
import {
  documentIndexLifecyclePatchSchema,
  documentIndexMaintenanceActionSchema,
} from "@/api/document-lifecycle";
import { getDb } from "@/lib/db";
import {
  getDocumentIndexInventory,
  readDocumentIndexLifecycleState,
  saveDocumentIndexLifecycleSettings,
  startDocumentIndexMaintenance,
} from "@/lib/documents/lifecycle";
import { getDocumentSource } from "@/lib/stores/document-sources";
import { errorResponse, validateBody } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

// UI-internal lifecycle controls (ADR-0133). Actions run in the background on
// a writer worker; the panel polls GET until `status.running` clears.
export async function GET() {
  getDb();
  return NextResponse.json(await readDocumentIndexLifecycleState());
}

export async function PATCH(req: NextRequest) {
  getDb();
  const parsed = await validateBody(req, documentIndexLifecyclePatchSchema);
  if (parsed instanceof NextResponse) return parsed;
  saveDocumentIndexLifecycleSettings(parsed);
  return NextResponse.json(await readDocumentIndexLifecycleState());
}

export async function POST(req: NextRequest) {
  getDb();
  const parsed = await validateBody(req, documentIndexMaintenanceActionSchema);
  if (parsed instanceof NextResponse) return parsed;

  if (parsed.action === "purge_source" && !getDocumentSource(parsed.source_id)) {
    return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  }
  if (parsed.action === "reclaim") {
    const inventory = await getDocumentIndexInventory();
    if (inventory.auto_vacuum === "none") {
      return errorResponse(
        "This database does not use incremental auto-vacuum yet. Run database compaction once to enable live space reclamation.",
        409,
      );
    }
  }

  const started = startDocumentIndexMaintenance(parsed);
  if (!started.started) {
    return errorResponse("Another document index maintenance action is already running", 409);
  }
  return NextResponse.json(
    { accepted: started.started, status: started.status },
    { status: 202 },
  );
}
