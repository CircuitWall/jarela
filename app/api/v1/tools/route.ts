import { NextResponse } from "next/server";
import { getAllTools, getAllToolsAsync, getToolCategory, getToolGroup } from "@/lib/tools";
import { cachedJson } from "@/lib/api/responses";
import { defaultToolStats, getToolStatsMap } from "@/lib/stores/tool-stats";

export async function GET() {
  try {
    // Use the async path so MCP-provided tools show up in the agent config UI.
    // Tag each tool's source so the UI can group "built-in" vs MCP-server tools.
    const builtInNames = new Set(getAllTools().map((t) => t.name));
    const all = await getAllToolsAsync();
    const stats = getToolStatsMap(all.map((t) => t.name));
    return cachedJson(
      all.map((t) => {
        const source: "builtin" | "mcp" = builtInNames.has(t.name) ? "builtin" : "mcp";
        return {
          name: t.name,
          description: t.description,
          source,
          category: getToolCategory(t.name, source),
          group: getToolGroup(t.name, source),
          stats: stats.get(t.name) ?? defaultToolStats(),
        };
      }).sort((a, b) => {
        const scoreDiff = (b.stats?.score ?? 0) - (a.stats?.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const usedDiff = (b.stats?.used_count ?? 0) - (a.stats?.used_count ?? 0);
        if (usedDiff !== 0) return usedDiff;
        return a.name.localeCompare(b.name);
      }),
      60,
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list tools", detail: String(err) },
      { status: 500 },
    );
  }
}
