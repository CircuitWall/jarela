import { NextRequest } from "next/server";
import { z } from "zod";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { AdvertisementPolicySchema } from "@/lib/agents/advertisement-contract";
import { advertisementService } from "@/lib/agents/advertisement-service";
import { getAdvertisementPolicy } from "@/lib/stores/agent-advertisements";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

const agentId = z.string().min(1).max(200);
const actionSchema = z.strictObject({
  agent_id: agentId, action: z.enum(["regenerate", "disable", "enable"]),
});
const policySchema = z.strictObject({ policy: AdvertisementPolicySchema });
function failure(message: string, status: number) {
  const result = errorResponse(message, status);
  result.headers.set("Cache-Control", "no-store");
  return result;
}
function guard(req: NextRequest) {
  const refused = localExecutionGuard(req);
  refused?.headers.set("Cache-Control", "no-store");
  return refused;
}
async function response(id: string | null) {
  return noStoreJson({ policy: getAdvertisementPolicy(), advertisement: id ? await advertisementService().inspect(id) : null });
}
export async function GET(req: NextRequest) {
  const refused = guard(req);
  if (refused) return refused;
  const raw = req.nextUrl.searchParams.get("agent_id");
  if (raw !== null && !agentId.safeParse(raw).success) return failure("Invalid agent id", 400);
  try { return await response(raw); }
  catch { console.warn("[advertisements] inspection failed"); return failure("Advertisement inspection failed", 500); }
}
async function readBody(req: NextRequest): Promise<unknown> {
  const body = await req.text();
  if (Buffer.byteLength(body) > 16384) throw new Error("body_limit");
  return JSON.parse(body);
}
export async function POST(req: NextRequest) {
  const refused = guard(req);
  if (refused) return refused;
  try {
    const body = actionSchema.parse(await readBody(req));
    const service = advertisementService();
    const state = body.action === "regenerate" ? await service.refresh(body.agent_id, true)
      : await service.setEnabled(body.agent_id, body.action === "enable");
    if (!state) return failure(NOT_FOUND_ERRORS.AGENT, 404);
    return await response(body.agent_id);
  } catch {
    console.warn("[advertisements] action refused");
    return failure("Advertisement action refused; check fields, saved agent and generation policy", 400);
  }
}
export async function PUT(req: NextRequest) {
  const refused = guard(req);
  if (refused) return refused;
  try {
    const body = policySchema.parse(await readBody(req));
    await advertisementService().configure(body.policy);
    return await response(null);
  } catch {
    console.warn("[advertisements] policy refused");
    return failure("Generation policy refused; select an existing enabled model and bounded limits", 400);
  }
}
