import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tool-stats-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  defaultToolStats,
  getToolStatsMap,
  recordToolUsage,
  summarizeToolUsage,
} = await import("./tool-stats");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("tool usefulness telemetry", () => {
  beforeEach(() => {
    // isolate tests by using distinct tool names; simpler than re-opening the DB.
  });

  it("treats never-used tools as 100 percent useful by default", () => {
    const stats = defaultToolStats();
    expect(stats.never_used).toBe(true);
    expect(stats.score).toBe(1);
    expect(stats.success_rate).toBe(1);
    expect(stats.usefulness_rate).toBe(1);
  });

  it("counts success, errors, and heuristic usage from one turn", () => {
    const rows = summarizeToolUsage([
      { id: "a", phase: "call", name: "web_search", payload: { q: "jarela docs" } },
      { id: "a", phase: "result", name: "web_search", payload: { title: "Jarela Docs", url: "https://example.test/docs" } },
      { id: "b", phase: "call", name: "shell_exec", payload: { cmd: "bad" } },
      { id: "b", phase: "result", name: "shell_exec", payload: { error: "permission denied" } },
    ], "Use the Jarela Docs result from https://example.test/docs.");

    expect(rows).toEqual([
      { name: "web_search", calls: 1, successes: 1, errors: 0, used: 1 },
      { name: "shell_exec", calls: 1, successes: 0, errors: 1, used: 0 },
    ]);
  });

  it("persists aggregate counts and derived scores", () => {
    const unique = `documents_search_${Date.now()}`;
    recordToolUsage([
      { id: "c", phase: "call", name: unique, payload: { q: "roadmap" } },
      { id: "c", phase: "result", name: unique, payload: { excerpt: "Roadmap item alpha" } },
    ], "Roadmap item alpha is the top match.");

    const stats = getToolStatsMap([unique]).get(unique);
    expect(stats).toBeTruthy();
    expect(stats?.never_used).toBe(false);
    expect(stats?.call_count).toBe(1);
    expect(stats?.success_count).toBe(1);
    expect(stats?.error_count).toBe(0);
    expect(stats?.used_count).toBe(1);
    expect(stats?.score).toBe(1);
  });
});