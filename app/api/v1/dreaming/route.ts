import { NextRequest, NextResponse } from "next/server";
import { dreamSkipReasonSchema, dreamTriggerSchema, dreamingPatchSchema } from "@/api/dreaming";
import { getDb } from "@/lib/db";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import {
  getDreamingOverview,
  setAgentDreamingEnabled,
  startDream,
  updateDreamingSettings,
} from "@/lib/agents/dreaming";
import { errorResponse, validateBody } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

// UI-internal dreaming controls (ADR-0135). GET is polled while a dream runs;
// POST returns 202 and the caller polls GET until `running` clears.
export async function GET() {
  getDb();
  return NextResponse.json(getDreamingOverview());
}

export async function PATCH(req: NextRequest) {
  getDb();
  const parsed = await validateBody(req, dreamingPatchSchema);
  if (parsed instanceof NextResponse) return parsed;

  if (parsed.agent && !getAgentConfig(parsed.agent.agent_id)) {
    return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  }
  if (parsed.settings) updateDreamingSettings(parsed.settings);
  if (parsed.agent) setAgentDreamingEnabled(parsed.agent.agent_id, parsed.agent.enabled);
  return NextResponse.json(getDreamingOverview());
}

export async function POST(req: NextRequest) {
  getDb();
  const parsed = await validateBody(req, dreamTriggerSchema);
  if (parsed instanceof NextResponse) return parsed;
  if (!getAgentConfig(parsed.agent_id)) {
    return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  }

  const started = startDream(parsed.agent_id, parsed.kind, { force: parsed.force });
  if (!started.started) {
    const reason = dreamSkipReasonSchema.safeParse(started.reason);
    if (reason.success && reason.data === "dream_running") {
      return errorResponse("A dream is already running", 409);
    }
    return errorResponse(
      `This agent is not eligible to dream right now${reason.success ? ` (${reason.data})` : ""}`,
      409,
    );
  }
  return NextResponse.json({ accepted: true, run: started.run }, { status: 202 });
}
