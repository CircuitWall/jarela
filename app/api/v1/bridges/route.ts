import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBridge, listBridges } from "@/lib/stores/bridges";
import { bridgeToResponse } from "@/lib/api/serializers";
import { createdResponse, validateBody } from "@/lib/api/responses";

export function GET() {
  return NextResponse.json(listBridges().map(bridgeToResponse));
}

const CreateSchema = z.object({
  kind: z.literal("whatsapp"),
  name: z.string().trim().min(1).max(120),
});

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, CreateSchema);
  if (parsed instanceof NextResponse) return parsed;
  const row = createBridge(parsed);
  return createdResponse(bridgeToResponse(row));
}
