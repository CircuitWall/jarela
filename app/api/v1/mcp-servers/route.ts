import { NextRequest, NextResponse } from "next/server";
import {
  listMcpServers,
  upsertMcpServer,
  type McpServerInput,
  type McpServerRow,
} from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";

function toResponse(r: McpServerRow) {
  return {
    name: r.name,
    transport: r.transport,
    spec: JSON.parse(r.spec),
    enabled: r.enabled === 1,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function GET() {
  return NextResponse.json(listMcpServers().map(toResponse));
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as McpServerInput;
  if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (body.transport !== "stdio" && body.transport !== "http") {
    return NextResponse.json({ error: "transport must be 'stdio' or 'http'" }, { status: 400 });
  }
  const row = upsertMcpServer({
    name: body.name.trim(),
    transport: body.transport,
    spec: body.spec,
    enabled: body.enabled,
  });
  invalidateMcpTools();
  return NextResponse.json(toResponse(row), { status: 201 });
}
