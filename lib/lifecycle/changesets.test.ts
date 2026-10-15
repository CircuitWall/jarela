import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changesetFileSchema,
  changesetsBetween,
  compareVersions,
  formatChangesetsForPrompt,
  loadBundledChangesets,
  summarizeChangesets,
  type ReleaseChangeset,
} from "./changesets";

function entry(version: string, previous: string | null, overrides: Partial<ReleaseChangeset> = {}): ReleaseChangeset {
  return { version, previous_version: previous, date: "2026-01-01", hints: [], commits: [], prompts: [], tools: [], ...overrides };
}

const tool = (name: string, change: "added" | "removed" | "changed") => ({
  name, change, description_changed: change === "changed", description: `${name} does things.`,
  params_added: [], params_removed: [], params_changed: [], required_added: [], required_removed: [],
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.5", "2.0.5")).toBe(0);
    expect(compareVersions("1.99.0", "2.0.0")).toBeLessThan(0);
  });
});

describe("changesetsBetween", () => {
  const all = [entry("2.0.1", "2.0.0"), entry("2.1.0", "2.0.1"), entry("2.2.0", "2.1.0")];

  it("returns the cumulative range (previous, current] and marks full coverage", () => {
    const range = changesetsBetween("2.0.1", "2.2.0", all);
    expect(range.entries.map((e) => e.version)).toEqual(["2.1.0", "2.2.0"]);
    expect(range.complete).toBe(true);
  });

  it("flags partial coverage when the range starts before the first changeset", () => {
    const range = changesetsBetween("1.9.0", "2.2.0", all);
    expect(range.entries).toHaveLength(3);
    expect(range.complete).toBe(false);
  });

  it("flags partial coverage when the current version has no changeset", () => {
    expect(changesetsBetween("2.1.0", "2.3.0", all).complete).toBe(false);
  });
});

describe("summarizeChangesets and formatChangesetsForPrompt", () => {
  const entries = [
    entry("2.1.0", "2.0.0", {
      hints: ["Re-check watchers."],
      tools: [tool("old_tool", "removed"), tool("search", "changed")],
      prompts: [{ id: "system.Tool usage SOP", source: "s.ts", change: "changed", added_lines: ["+rule"], removed_lines: ["-rule"], omitted_lines: 2 }],
    }),
    entry("2.2.0", "2.1.0", { tools: [tool("old_tool", "added")] }),
  ];

  it("keeps the latest state of each surface across the range", () => {
    expect(summarizeChangesets(entries)).toEqual({
      promptIds: ["system.Tool usage SOP"],
      toolNames: ["old_tool", "search"],
      removedTools: [],
      hints: ["2.1.0: Re-check watchers."],
    });
  });

  it("renders hints, tool deltas, and prompt excerpts within the budget", () => {
    const text = formatChangesetsForPrompt(entries);
    expect(text).toContain("adoption hint: Re-check watchers.");
    expect(text).toContain("tool `old_tool`: removed");
    expect(text).toContain("+ +rule");
    expect(text).toContain("2 more changed line(s)");
    expect(formatChangesetsForPrompt(entries, 40).length).toBeLessThan(200);
  });
});

describe("bundled changesets", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "docs/adoption/changesets.json"), "utf8"));
  const bundled = loadBundledChangesets();

  it("matches the schema", () => {
    expect(changesetFileSchema.safeParse(raw).success).toBe(true);
    expect(bundled.length).toBe(raw.changesets.length);
  });

  it("has an entry for the package.json version so the release PR cannot skip it", () => {
    const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(bundled.map((e) => e.version), "run `npm run release:changeset` in the release PR").toContain(version);
    const snapshot = JSON.parse(readFileSync(join(process.cwd(), "docs/adoption/surface-snapshot.json"), "utf8"));
    expect(snapshot.version).toBe(version);
  });

  it("chains each release to its predecessor without gaps", () => {
    for (let i = 1; i < bundled.length; i++) {
      expect(bundled[i].previous_version, bundled[i].version).toBe(bundled[i - 1].version);
    }
  });
});
