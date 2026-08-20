import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tool-stats-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  defaultToolStats,
  getToolStatsMap,
  listToolFailureSamples,
  recordToolUsage,
  summarizeToolFailureSamples,
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

  it("summarizes failures into bounded categories without raw arguments", () => {
    const rows = summarizeToolFailureSamples([
      {
        id: "secret-call",
        phase: "call",
        name: "gmail_modify_message",
        payload: { id: "raw-message-id", refresh_token: "super-secret-token", remove_labels: ["INBOX"] },
      },
      {
        id: "secret-call",
        phase: "result",
        name: "gmail_modify_message",
        payload: { error: "401 invalid access_token=abc123 super-secret-token" },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "gmail_modify_message", reason: "auth" });
    expect(rows[0].argShape).toContain("remove_labels");
    expect(rows[0].argShape).not.toContain("raw-message-id");
    expect(rows[0].sampleError).not.toContain("super-secret-token");
  });

  it("persists bounded failure samples by category instead of per call", () => {
    const unique = `bad_tool_${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      recordToolUsage([
        { id: `x${i}`, phase: "call", name: unique, payload: { path: `/tmp/raw-${i}.txt`, token: `secret-${i}` } },
        { id: `x${i}`, phase: "result", name: unique, payload: { error: `ENOENT missing /tmp/raw-${i}.txt ${"x".repeat(400)}` } },
      ], "");
    }

    const rows = listToolFailureSamples(unique);
    expect(rows).toHaveLength(1);
    expect(rows[0].normalized_reason).toBe("not_found");
    expect(rows[0].count).toBe(3);
    expect(rows[0].sample_error.length).toBeLessThanOrEqual(300);
    expect(rows[0].sample_arg_shape).toContain("path");
    expect(rows[0].sample_arg_shape).not.toContain("raw-2.txt");
    expect(rows[0].sample_arg_shape).not.toContain("secret-2");
  });
});
