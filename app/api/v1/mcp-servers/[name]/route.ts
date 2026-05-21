import { NextRequest, NextResponse } from "next/server";
import {
  deleteMcpServer,
  getMcpServer,
  upsertMcpServer,
  type McpServerInput,
} from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";
import { mcpServerToResponse } from "@/lib/api/serializers";
import { notFoundResponse } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

type Params = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const r = getMcpServer(name);
  if (!r) return notFoundResponse("MCP server not found");
  return NextResponse.json(mcpServerToResponse(r));
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const existing = getMcpServer(name);
  if (!existing) return notFoundResponse("MCP server not found");
  const body = (await req.json()) as Partial<McpServerInput>;
  const row = upsertMcpServer({
    name,
    transport: body.transport ?? (existing.transport as "stdio" | "http"),
    spec: body.spec ?? parseJsonSafe<McpServerInput["spec"]>(existing.spec, {} as McpServerInput["spec"]),
    enabled: body.enabled ?? (existing.enabled === 1),
  });
  invalidateMcpTools();
  return NextResponse.json(mcpServerToResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const ok = deleteMcpServer(name);
  if (!ok) return notFoundResponse("MCP server not found");
  invalidateMcpTools();
  return NextResponse.json({ deleted: true });
}
