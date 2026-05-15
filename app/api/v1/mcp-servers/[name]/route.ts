import { NextRequest, NextResponse } from "next/server";
import {
  deleteMcpServer,
  getMcpServer,
  upsertMcpServer,
  type McpServerInput,
} from "@/lib/stores/mcp-servers";
import { invalidateMcpTools } from "@/lib/mcp/client";

type Params = { params: Promise<{ name: string }> };

function toResponse(r: ReturnType<typeof getMcpServer>) {
  if (!r) return null;
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

export async function GET(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const r = getMcpServer(name);
  if (!r) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  return NextResponse.json(toResponse(r));
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const existing = getMcpServer(name);
  if (!existing) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  const body = (await req.json()) as Partial<McpServerInput>;
  const row = upsertMcpServer({
    name,
    transport: body.transport ?? (existing.transport as "stdio" | "http"),
    spec: body.spec ?? JSON.parse(existing.spec),
    enabled: body.enabled ?? (existing.enabled === 1),
  });
  invalidateMcpTools();
  return NextResponse.json(toResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const ok = deleteMcpServer(name);
  if (!ok) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  invalidateMcpTools();
  return NextResponse.json({ deleted: true });
}
