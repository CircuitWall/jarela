/**
 * @public — `GET /api/v1/tools`
 *
 * Lists every tool in the agent's pool — built-in, external (loaded from
 * `~/.jarela/tools/*.cjs`), and MCP — with category, capability, source,
 * and per-tool stats. The agent-callable equivalent is the `list_tools`
 * tool. See `docs/api.md`.
 */

import { NextResponse } from "next/server";
import { getAllToolsAsync, getToolCategory, getToolCapability, getToolGroup, getToolSource, getToolCredentialsRequired } from "@/lib/tools";
import { cachedJson } from "@/lib/api/responses";
import { defaultToolStats, getToolStatsMap } from "@/lib/stores/tool-stats";

interface ToolEnvelope {
  name: string;
  description: string;
  source: string;
  category: string;
  capability: string;
  group: string | null;
  credentials_required: string[];
  stats: ReturnType<typeof defaultToolStats>;
}

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
    // Use the async path so MCP-provided tools show up in the agent config UI.
    // Source ("builtin" | "external" | "mcp") is derived inside lib/tools so
    // callers can't conflate external tools with MCP tools.
    const all = await getAllToolsAsync();
    const stats = getToolStatsMap(all.map((t) => t.name));
    const rows: ToolEnvelope[] = all.map((t) => ({
        name: t.name,
        description: t.description,
        source: getToolSource(t.name),
        category: getToolCategory(t.name),
        capability: getToolCapability(t.name),
        group: getToolGroup(t.name),
        credentials_required: getToolCredentialsRequired(t.name),
        stats: stats.get(t.name) ?? defaultToolStats(),
      }));
    return cachedJson(
      rows.filter((tool) => !q || toolSearchText(tool).includes(q)).sort((a, b) => {
        const scoreDiff = (b.stats?.score ?? 0) - (a.stats?.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const usedDiff = (b.stats?.used_count ?? 0) - (a.stats?.used_count ?? 0);
        if (usedDiff !== 0) return usedDiff;
        return a.name.localeCompare(b.name);
      }),
      60, 120,
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list tools", detail: String(err) },
      { status: 500 },
    );
  }
}

function toolSearchText(tool: ToolEnvelope): string {
  return [tool.name, tool.description, tool.category, tool.capability, tool.source, tool.group ?? ""]
    .join(" ")
    .toLowerCase();
}
