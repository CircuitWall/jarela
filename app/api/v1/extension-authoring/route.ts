import { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { ExtensionCreateInput, ExtensionStageInput, extensionService } from "@/lib/workflows/extension-service";

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), agentId: z.string().min(1).max(200), workspace: z.string().min(1).max(4096), input: ExtensionCreateInput }),
  z.strictObject({ action: z.literal("request"), agentId: z.string().min(1).max(200), input: ExtensionStageInput }),
]);
export async function POST(req: NextRequest) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 65536) return errorResponse("Authoring input exceeds 64 KiB", 400);
    const body = bodySchema.parse(JSON.parse(text));
    return noStoreJson(body.action === "create"
      ? extensionService().create(body.agentId, body.workspace, body.input)
      : extensionService().request(body.agentId, body.input));
  } catch (error) {
    console.warn("[authoring] request refused", error instanceof z.ZodError || error instanceof SyntaxError
      ? "Invalid authoring fields" : error instanceof Error ? error.message : "unknown failure");
    return errorResponse(error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid authoring fields" : "Authoring scope, policy or stage prerequisites refused", 400);
  }
}
export async function GET(req: NextRequest) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  const id = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!id.success || !agentId) return errorResponse("Session id and agentId are required", 400);
  try { return noStoreJson(extensionService().inspect(id.data, agentId)); }
  catch { return errorResponse("Authoring session unavailable", 404); }
}
