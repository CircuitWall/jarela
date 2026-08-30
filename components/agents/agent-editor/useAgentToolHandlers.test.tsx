import { describe, expect, it } from "vitest";
import type { ToolInfo } from "@/api/types";
import { buildGroupedTools } from "./useAgentToolHandlers";

const tool = (name: string, category?: string, group?: string | null): ToolInfo => ({
  name,
  description: name,
  category,
  group,
});

describe("buildGroupedTools", () => {
  it("groups Basic categories above Work and defaults missing categories to Other", () => {
    const grouped = buildGroupedTools([
      tool("github_list_issues", "GitHub", "Work"),
      tool("memory_read", "Memory", "Basic"),
      tool("file_read", "Files", "Basic"),
      tool("uncategorized_tool"),
    ]);

    expect(grouped.map((group) => group.group)).toEqual(["Basic", "Work", null]);
    expect(grouped[0].categories.map(([category]) => category)).toEqual(["Memory", "Files"]);
    expect(grouped[1].categories.map(([category]) => category)).toEqual(["GitHub"]);
    expect(grouped[2].categories.map(([category]) => category)).toEqual(["Other"]);
  });
});