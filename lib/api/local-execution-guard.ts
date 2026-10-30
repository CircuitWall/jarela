import { isLoopbackRequest } from "@/lib/auth/access";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import { isScreenLocked } from "@/lib/security/screen-lock";
import { errorResponse } from "./responses";

export function localExecutionGuard(req: Request) {
  if (!isLoopbackRequest(req) || req.headers.get("tailscale-user-login")) return errorResponse("loopback-only", 403);
  if (isMasterKeyLocked() || isScreenLocked()) return errorResponse("locked", 423);
  return null;
}
