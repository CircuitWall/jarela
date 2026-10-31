import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tool-stats-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  defaultToolStats,
  getToolStatsMap,
  getToolFailurePatterns,
  listToolFailureSamples,
  pruneToolFailureSamples,
  recordToolUsage,
  summarizeToolFailureSamples,
  summarizeToolUsage,
  toStats,
} = await import("./tool-stats");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("tool usefulness telemetry", () => {
  it("ignores empty turns, lists all stats and preserves defaults for zero-call rows", () => {
    expect(() => recordToolUsage([], "")).not.toThrow();
    expect(toStats({
      tool_name: "synthetic", call_count: 0, success_count: 0, error_count: 0,
      used_count: 0, last_called_at: null, updated_at: "2026-10-31T00:00:00Z",
    })).toEqual(defaultToolStats());
    getDb().prepare(`INSERT INTO tool_stats (tool_name, call_count, success_count, error_count, used_count, updated_at)
      VALUES ('synthetic-zero',0,0,0,0,'2026-10-31T00:00:00Z')`).run();
    expect(getToolStatsMap().get("synthetic-zero")).toEqual(defaultToolStats());
    expect(pruneToolFailureSamples("invalid timestamp")).toBeGreaterThanOrEqual(0);
  });

  it("handles missing names, synthetic phase IDs and non-object payloads", () => {
    expect(summarizeToolUsage([
      { id: "", phase: "call", name: "", payload: null },
      { id: "", phase: "call", name: "synthetic", payload: null },
      { id: "", phase: "result", name: "synthetic", payload: null },
    ], "")).toEqual([{ name: "synthetic", calls: 1, successes: 0, errors: 1, used: 0 }]);
    expect(summarizeToolFailureSamples([
      { id: "synthetic", phase: "call", name: "synthetic", payload: {} },
      { id: "synthetic", phase: "result", name: "synthetic", payload: { status: "failed", message: "Synthetic failure" } },
    ])).toHaveLength(1);
  });
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

  it("retrieves only bounded, recent, recurring patterns for selected tools without raw samples", () => {
    const names = ["retrieval_alpha", "retrieval_beta", "retrieval_gamma", "retrieval_delta", "retrieval_stale", "retrieval_once", "retrieval_skip"];
    for (const name of names) {
      for (let i = 0; i < (name === "retrieval_once" ? 1 : 2); i++) {
        recordToolUsage([
          { id: `${name}-${i}`, phase: "call", name, payload: { path: "private-path" } },
          { id: `${name}-${i}`, phase: "result", name, payload: { error: "timeout private-error" } },
        ], "");
      }
    }
    getDb().prepare("UPDATE tool_failure_samples SET last_seen_at = ? WHERE tool_name = ?")
      .run("2000-01-01T00:00:00.000Z", "retrieval_stale");
    getDb().prepare("UPDATE tool_failure_samples SET failure_class = 'expected_skip' WHERE tool_name = ?")
      .run("retrieval_skip");

    expect(getToolFailurePatterns([])).toEqual([]);
    expect(getToolFailurePatterns(["unknown_tool"])).toEqual([]);
    expect(getToolFailurePatterns(["retrieval_stale", "retrieval_once", "retrieval_skip"])).toEqual([]);
    const patterns = getToolFailurePatterns(names);
    expect(patterns).toHaveLength(3);
    for (const pattern of patterns) {
      expect(Object.keys(pattern).sort()).toEqual(["count", "normalized_reason", "tool_name"]);
      expect(pattern).toMatchObject({ normalized_reason: "timeout", count: 2 });
      expect(["retrieval_alpha", "retrieval_beta", "retrieval_gamma", "retrieval_delta"]).toContain(pattern.tool_name);
    }
    expect(getToolFailurePatterns(["retrieval_beta"])).toEqual([
      { tool_name: "retrieval_beta", normalized_reason: "timeout", count: 2 },
    ]);
  });

  it("classifies failures for escalation without storing raw arguments", () => {
    const suffix = Date.now();
    const events = (name: string, error: string) => [
      { id: `${name}-call`, phase: "call" as const, name, payload: { token: "hidden" } },
      { id: `${name}-result`, phase: "result" as const, name, payload: { error } },
    ];
    recordToolUsage([
      ...events(`auth_${suffix}`, "401 unauthorized"),
      ...events(`timeout_${suffix}`, "timeout while contacting service"),
      ...events(`schema_${suffix}`, "schema validation failed"),
      ...events(`skip_${suffix}`, "skipped: duplicate event"),
    ], "");

    expect(listToolFailureSamples(`auth_${suffix}`)[0].failure_class).toBe("configuration_problem");
    expect(listToolFailureSamples(`timeout_${suffix}`)[0].failure_class).toBe("transient_tool_failure");
    expect(listToolFailureSamples(`schema_${suffix}`)[0].failure_class).toBe("suspected_product_gap");
    expect(listToolFailureSamples(`skip_${suffix}`)[0].failure_class).toBe("expected_skip");
  });

  it("persists sanitized workflow context for blocked operations", () => {
    const name = `context_tool_${Date.now()}`;
    recordToolUsage([
      { id: "context-call", phase: "call", name, payload: { value: "x" } },
      { id: "context-call", phase: "result", name, payload: { error: "schema validation failed" } },
    ], "The extraction produced a candidate.", {
      workflowName: "watcher",
      eventType: "calendar_event",
      extractionValid: true,
    });

    expect(listToolFailureSamples(name)[0]).toMatchObject({
      workflow_name: "watcher",
      event_type: "calendar_event",
      extraction_valid: 1,
      intended_tool: name,
      blocked_operation: "validation",
    });
  });

  it("separates caller schema rejections from internal validation failures", () => {
    const name = `caller_schema_${Date.now()}`;
    recordToolUsage([
      { id: "caller", phase: "call", name, payload: { context: 6 } },
      { id: "caller", phase: "result", name, payload: { error: "Received tool input did not match expected schema\ncontext must be <=5" } },
      { id: "internal", phase: "call", name, payload: { context: 1 } },
      { id: "internal", phase: "result", name, payload: { error: "response schema validation failed" } },
    ], "");

    expect(listToolFailureSamples(name)).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalized_reason: "caller_arguments", failure_class: "caller_argument_error", count: 1 }),
      expect.objectContaining({ normalized_reason: "validation", failure_class: "suspected_product_gap", count: 1 }),
    ]));
  });

  it.each(["invalid_tool_arguments", "bad_args_json"])("recognizes structured caller errors (%s)", (code) => {
    for (const payload of [{ error_code: code, error: "invalid field" }, JSON.stringify({ error_code: code, error: "invalid field" })]) {
      const samples = summarizeToolFailureSamples([{ id: "typed", phase: "result", name: "invoke_tool", payload }]);
      expect(samples[0]).toMatchObject({ reason: "caller_arguments", failureClass: "caller_argument_error" });
    }
  });

  it.each(["", "Error: "])("recognizes SDK and ToolNode input rejections (prefix=%s)", (prefix) => {
    const samples = summarizeToolFailureSamples([{
      id: "plain", phase: "result", name: "file_grep",
      payload: `${prefix}Received tool input did not match expected schema\ncontext must be <=5`,
    }]);
    expect(samples[0]).toMatchObject({ reason: "caller_arguments", failureClass: "caller_argument_error" });
  });

  it("reclassifies historical boundary rejections on read without rewriting stored evidence", () => {
    const name = `historical_schema_${Date.now()}`;
    recordToolUsage([
      { id: "old", phase: "call", name, payload: { context: 6 } },
      { id: "old", phase: "result", name, payload: { error: "Error: Received tool input did not match expected schema" } },
    ], "");
    getDb().prepare("UPDATE tool_failure_samples SET normalized_reason='validation', failure_class='suspected_product_gap' WHERE tool_name=?").run(name);
    expect(listToolFailureSamples(name)[0]).toMatchObject({
      normalized_reason: "caller_arguments", failure_class: "caller_argument_error", count: 1,
    });
    expect(getDb().prepare("SELECT normalized_reason FROM tool_failure_samples WHERE tool_name=?").get(name))
      .toMatchObject({ normalized_reason: "validation" });
  });

  it("prunes stale failure samples by TTL", () => {
    const old = "2026-01-01T00:00:00.000Z";
    const current = "2026-02-15T00:00:00.000Z";
    getDb().prepare(
      `INSERT OR REPLACE INTO tool_failure_samples
        (tool_name, normalized_reason, count, sample_error, sample_arg_shape, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("stale_tool", "timeout", 2, "old", "{}", old, old);
    getDb().prepare(
      `INSERT OR REPLACE INTO tool_failure_samples
        (tool_name, normalized_reason, count, sample_error, sample_arg_shape, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("fresh_tool", "timeout", 2, "new", "{}", current, current);

    expect(pruneToolFailureSamples(current)).toBeGreaterThanOrEqual(1);

    expect(listToolFailureSamples("stale_tool")).toHaveLength(0);
    expect(listToolFailureSamples("fresh_tool")).toHaveLength(1);
  });
});
