import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBridge, listBridges } from "@/lib/stores/bridges";
import { bridgeToResponse } from "@/lib/api/serializers";
import { createdResponse, validateBody, cachedJson } from "@/lib/api/responses";
import { isBridgeKind } from "@/lib/bridges/registry";

export function GET() {
  return cachedJson(listBridges().map(bridgeToResponse), 15);
}

const CreateSchema = z.object({
  kind: z.string().trim().min(1).refine(isBridgeKind, "Unknown bridge kind"),
  name: z.string().trim().min(1).max(120),
});

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, CreateSchema);
  if (parsed instanceof NextResponse) return parsed;
  const row = createBridge(parsed);
  return createdResponse(bridgeToResponse(row));
}
