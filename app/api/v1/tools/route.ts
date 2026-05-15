import { NextResponse } from "next/server";
import { getAllTools, getAllToolsAsync } from "@/lib/tools";

export async function GET() {
  try {
    // Use the async path so MCP-provided tools show up in the agent config UI.
    // Tag each tool's source so the UI can group "built-in" vs MCP-server tools.
    const builtInNames = new Set(getAllTools().map((t) => t.name));
    const all = await getAllToolsAsync();
    return NextResponse.json(
      all.map((t) => ({
        name: t.name,
        description: t.description,
        source: builtInNames.has(t.name) ? "builtin" : "mcp",
      })),
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list tools", detail: String(err) },
      { status: 500 },
    );
  }
}
