import { NextRequest, NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/auth/access";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import { isScreenLocked } from "@/lib/security/screen-lock";
import { errorResponse, noStoreJson, validateBody } from "@/lib/api/responses";
import { SkillExecutionPolicySchema } from "@/lib/skills/execution-policy";
import { getSkillExecutionPolicy, setSkillExecutionPolicy, isSkillTrustWorkspace } from "@/lib/stores/app-settings";
import { resolveSafetyMode } from "@/lib/tools/security/safety";
import { getSkillProcessOwnerAvailability } from "@/lib/skills/process-owner";

function guard(req: Request) {
  if (!isLoopbackRequest(req) || req.headers.get("tailscale-user-login")) return errorResponse("loopback-only", 403);
  if (isMasterKeyLocked() || isScreenLocked()) return errorResponse("locked", 423);
  return null;
}

function response() {
  const ownership = getSkillProcessOwnerAvailability();
  return noStoreJson({ policy: getSkillExecutionPolicy(), safety_mode: resolveSafetyMode(), execution_available: ownership.available, ownership });
}

export function GET(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  return response();
}

export async function PUT(req: NextRequest) {
  const refused = guard(req);
  if (refused) return refused;
  const policy = await validateBody(req, SkillExecutionPolicySchema);
  if (policy instanceof NextResponse) return policy;
  if (policy.trusted_revisions.some((grant) => !isSkillTrustWorkspace(grant.workspace))) {
    return errorResponse("Trusted workspace must be an absolute normalized host path", 400);
  }
  setSkillExecutionPolicy(policy);
  return response();
}
