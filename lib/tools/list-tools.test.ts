import { describe, it, expect, afterAll } from "vitest";
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

const { listToolsTool } = await import("./list-tools");

interface Result {
  tools: Array<{
    name: string;
    description: string;
    category: string;
    capability: string;
    source: string;
    group: string | null;
  }>;
  counts: {
    total: number;
    by_source: Record<string, number>;
    by_capability: Record<string, number>;
  };
}

function parse(s: string): Result {
  return JSON.parse(s) as Result;
}

describe("list_tools", () => {
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
    }

    // Sanity: list_tools itself is registered as builtin/Config/read.
    const self = out.tools.find((t) => t.name === "list_tools");
    expect(self).toBeDefined();
    expect(self?.source).toBe("builtin");
    expect(self?.category).toBe("Config");
    expect(self?.capability).toBe("read");
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

  it("returns empty list (not error) when filters match nothing", async () => {
    const out = parse(await listToolsTool.invoke({ source: "external", capability: "read" }));
    // The clean-tmpdir HOME has no JARELA_TOOLS_DIR, so external is empty
    // regardless of capability — verifying empty-result is a normal shape.
    expect(out.tools).toEqual([]);
    expect(out.counts.total).toBe(0);
  });
});
