import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, validateBody } from "@/lib/api/responses";
import {
  beginInstall,
  listPendingInstalls,
} from "@/lib/tools/package-install";
import { errorMessage } from "@/lib/utils/error";

// Strict character sets so a malicious request can never reach
// `child_process.spawn` with shell metacharacters. The publisher
// allowlist in `lib/tools/package-allowlist.ts` is the trust check;
// these regexes are the syntactic guard that any reachable string is a
// real npm package spec / version, not a shell injection vector.
//
// `spec`    : npm package name with optional @scope/ and subpath.
// `version` : exact version, prerelease tag, or dist-tag (no `>=<` ranges,
//             which would be ambiguous under any shell anyway).
const NPM_SPEC = /^@?[A-Za-z0-9._~/-]+$/;
const NPM_VERSION = /^[A-Za-z0-9._~-]+$/;

const InstallSchema = z.object({
  spec: z
    .string()
    .min(1, "spec is required")
    .max(214, "spec too long")
    .regex(NPM_SPEC, "spec must be a valid npm package name"),
  version: z
    .string()
    .min(1)
    .max(64, "version too long")
    .regex(NPM_VERSION, "version must be a plain semver, prerelease, or dist-tag")
    .optional(),
});

export function GET() {
  return NextResponse.json(listPendingInstalls());
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, InstallSchema);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const outcome = await beginInstall(parsed);
    if (outcome.status === "pending") {
      return NextResponse.json(
        {
          status: "pending",
          approvalId: outcome.pending.id,
          publisher: outcome.pending.publisher,
          spec: outcome.pending.spec,
          reason: outcome.pending.reason,
        },
        { status: 202 },
      );
    }
    return NextResponse.json({ status: "installed", ...outcome.result });
  } catch (err) {
    return errorResponse(errorMessage(err), 500);
  }
}
