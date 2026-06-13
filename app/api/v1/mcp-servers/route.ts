import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listMcpServers,
  upsertMcpServer,
} from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";
import { mcpServerToResponse } from "@/lib/api/serializers";
import { createdResponse, cachedJson, validateBody } from "@/lib/api/responses";

const SpecSchema = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  name: z.string().trim().min(1, "name is required"),
  transport: z.enum(["stdio", "http"], { message: "transport must be 'stdio' or 'http'" }),
  spec: SpecSchema,
  enabled: z.boolean().optional(),
});

export function GET() {
  return cachedJson(listMcpServers().map(mcpServerToResponse), 15);
}

export async function POST(req: NextRequest) {
  const body = await validateBody(req, CreateBody);
  if (body instanceof NextResponse) return body;
  const row = upsertMcpServer({
    name: body.name,
    transport: body.transport,
    spec: body.spec as never,
    enabled: body.enabled,
  });
  invalidateMcpTools();
  return createdResponse(mcpServerToResponse(row));
}
