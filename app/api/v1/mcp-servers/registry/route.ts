import { NextResponse } from "next/server";
import { MCP_REGISTRY } from "@/lib/mcp/registry";

export function GET() {
  return NextResponse.json(MCP_REGISTRY);
}
