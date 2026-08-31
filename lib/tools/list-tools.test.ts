import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-list-tools-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { getDefaultAgentToolNames, getToolCategory } = await import("./index");
const { listToolsTool } = await import("./list-tools");
const { setCategoryEnabled } = await import("@/lib/stores/builtin-tools");

interface Result {
  tools: Array<{
    name: string;
    description: string;
    category: string;
    capability: string;
    source: string;
    group: string | null;
    status: "enabled" | "disabled" | "unavailable";
    status_reason: string | null;
    permission: "enabled" | "disabled" | "unavailable";
    permission_reason: string | null;
  }>;
  counts: {
    total: number;
    by_source: Record<string, number>;
    by_capability: Record<string, number>;
    by_permission: Record<string, number>;
  };
}

function parse(s: string): Result {
  return JSON.parse(s) as Result;
}

describe("list_tools", () => {
  beforeEach(() => {
    setCategoryEnabled("Memory", true);
  });

  it("returns every built-in tool with category, capability, and source", async () => {
    const out = parse(await listToolsTool.invoke({}));
    expect(out.tools.length).toBeGreaterThan(0);
    expect(out.counts.total).toBe(out.tools.length);

    // Every entry has the documented shape.
    for (const t of out.tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(["read", "write", "execute"]).toContain(t.capability);
      expect(["builtin", "external", "mcp"]).toContain(t.source);
      expect(["enabled", "disabled", "unavailable"]).toContain(t.status);
      expect(["enabled", "disabled", "unavailable"]).toContain(t.permission);
    }

    // Sanity: list_tools itself is registered as builtin/Config/read.
    const self = out.tools.find((t) => t.name === "list_tools");
    expect(self).toBeDefined();
    expect(self?.source).toBe("builtin");
    expect(self?.category).toBe("Config");
    expect(self?.capability).toBe("read");
    expect(self?.permission).toBe("enabled");
  });

  it("returns globally disabled tools without granting execution permission", async () => {
    setCategoryEnabled("Memory", false);

    const defaultView = parse(await listToolsTool.invoke({ query: "memory_read" }));
    expect(defaultView.tools).toHaveLength(1);
    expect(defaultView.tools[0]).toMatchObject({
      name: "memory_read",
      status: "disabled",
      status_reason: "category_disabled",
      permission: "unavailable",
      permission_reason: "category_disabled",
    });
  });

  it("marks known non-Basic tools disabled for the current agent by default", async () => {
    const out = parse(await listToolsTool.invoke({ query: "gmail_" }));
    const gmail = out.tools.find((tool) => tool.name.startsWith("gmail_"));
    expect(gmail).toBeDefined();
    expect(gmail?.permission).toBe("disabled");
    expect(gmail?.permission_reason).toBe("agent_not_allowed");
  });

  it("can list/search only enabled executable tools", async () => {
    const out = parse(await listToolsTool.invoke({ query: "gmail_", scope: "enabled" }));
    expect(out.tools).toEqual([]);

    const enabled = parse(await listToolsTool.invoke({ query: "file_read", scope: "enabled" }));
    expect(enabled.tools.map((tool) => tool.name)).toContain("file_read");
    expect(enabled.tools.every((tool) => tool.permission === "enabled")).toBe(true);
  });

  it("defaults uncategorized incoming tools to Other", () => {
    expect(getToolCategory("not_registered_anywhere")).toBe("Other");
  });

  it("defaults Basic category tools for every agent", () => {
    const defaults = getDefaultAgentToolNames();
    expect(defaults).toEqual(expect.arrayContaining([
      "memory_read",
      "file_read",
      "web_search",
      "schedule_task",
      "read_skill",
      "list_tools",
      "local_exec",
      "workflow_progress",
    ]));
    expect(getToolCategory("workflow_progress")).toBe("Agent");
  });

  it("filters by capability", async () => {
    const out = parse(await listToolsTool.invoke({ capability: "read" }));
    expect(out.tools.every((t) => t.capability === "read")).toBe(true);
    expect(out.counts.total).toBe(out.tools.length);
  });

  it("filters by source", async () => {
    const out = parse(await listToolsTool.invoke({ source: "builtin" }));
    expect(out.tools.every((t) => t.source === "builtin")).toBe(true);
  });

  it("searches by tool name, category, and description", async () => {
    const byName = parse(await listToolsTool.invoke({ query: "read_skill" }));
    expect(byName.tools.map((t) => t.name)).toContain("read_skill");
    expect(byName.tools.map((t) => t.name)).not.toContain("file_read");

    const byCategory = parse(await listToolsTool.invoke({ query: "skills" }));
    expect(byCategory.tools.some((t) => t.category === "Skills")).toBe(true);
  });

  it("uses the current run permission map when reporting cap-omitted tools", async () => {
    const out = parse(await listToolsTool.invoke(
      { query: "file_read", scope: "all" },
      {
        configurable: {
          agent_run_config: {
            tool_permission_map: [
              {
                name: "file_read",
                category: "Files",
                capability: "read",
                source: "builtin",
                permission: "disabled",
                permission_reason: "provider_tool_limit",
              },
            ],
          },
        },
      },
    ));

    expect(out.tools.find((tool) => tool.name === "file_read")).toMatchObject({
      permission: "disabled",
      permission_reason: "provider_tool_limit",
    });
  });

  it("surfaces efficiency guidance for shell and file tool selection", async () => {
    const out = parse(await listToolsTool.invoke({ include_disabled: true }));
    const descriptions = new Map(out.tools.map((t) => [t.name, t.description]));

    expect(descriptions.get("file_grep")).toContain("Prefer this over local_exec/shell_exec");
    expect(descriptions.get("file_multi_edit")).toContain("multiple file_edit round-trips");
    expect(descriptions.get("local_exec")).toContain("one-shot shell command");
    expect(descriptions.get("local_exec")).toContain("Prefer file_glob/file_grep/file_read/file_edit/file_multi_edit");
    expect(descriptions.get("terminal_exec")).toContain("interactive/stateful workflows");
  });

  it("returns empty list (not error) when filters match nothing", async () => {
    const out = parse(await listToolsTool.invoke({ source: "external", capability: "read" }));
    // The clean-tmpdir HOME has no JARELA_TOOLS_DIR, so external is empty
    // regardless of capability — verifying empty-result is a normal shape.
    expect(out.tools).toEqual([]);
    expect(out.counts.total).toBe(0);
  });
});
