import { NextRequest } from "next/server";
import {
  listMcpServers,
  upsertMcpServer,
  type McpServerInput,
} from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";
import { mcpServerToResponse } from "@/lib/api/serializers";
import { errorResponse, createdResponse, cachedJson } from "@/lib/api/responses";

export function GET() {
  return cachedJson(listMcpServers().map(mcpServerToResponse), 15);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as McpServerInput;
  if (!body.name?.trim()) return errorResponse("name is required");
  if (body.transport !== "stdio" && body.transport !== "http") {
    return errorResponse("transport must be 'stdio' or 'http'");
  }
  const row = upsertMcpServer({
    name: body.name.trim(),
    transport: body.transport,
    spec: body.spec,
    enabled: body.enabled,
  });
  invalidateMcpTools();
  return createdResponse(mcpServerToResponse(row));
}
