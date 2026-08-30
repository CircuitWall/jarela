import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tool-telemetry-issue-"));
process.env.JARELA_DB_DIR = tmpRoot;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { recordToolUsage } = await import("@/lib/stores/tool-stats");
const {
  buildToolTelemetryComplaintIssue,
  maybeAutoFileToolTelemetryIssue,
  reportToolTelemetryIssueTool,
} = await import("./tool-telemetry-issue");
const { getFingerprint } = await import("@/lib/stores/change-tracker");

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe("report_tool_telemetry_issue", () => {
  it("builds one complaint issue across multiple failing tools", async () => {
    const suffix = `${Date.now()}`;
    const fileTool = `file_read_${suffix}`;
    const webTool = `web_search_${suffix}`;

    recordToolUsage([
      { id: "a", phase: "call", name: fileTool, payload: { path: "secret-path.txt", token: "hidden" } },
      { id: "a", phase: "result", name: fileTool, payload: { error: "ENOENT missing secret-path.txt" } },
      { id: "b", phase: "call", name: webTool, payload: { query: "rate limit" } },
      { id: "b", phase: "result", name: webTool, payload: { error: "429 rate limited" } },
      { id: "c", phase: "call", name: fileTool, payload: { path: "secret-path-2.txt", token: "hidden-again" } },
      { id: "c", phase: "result", name: fileTool, payload: { error: "ENOENT missing secret-path-2.txt" } },
      { id: "d", phase: "call", name: webTool, payload: { query: "rate limit again" } },
      { id: "d", phase: "result", name: webTool, payload: { error: "429 rate limited again" } },
    ], "");

    const issue = buildToolTelemetryComplaintIssue({ tool_names: [fileTool, webTool] });

    expect(issue.tool_count).toBe(2);
    expect(issue.tools).toEqual(expect.arrayContaining([fileTool, webTool]));
    expect(issue.title).toContain("2 tools");
    expect(issue.body).toContain(`### ${fileTool}`);
    expect(issue.body).toContain(`### ${webTool}`);
    expect(issue.body).toContain("Failure scenarios");
    expect(issue.body).toContain("rate_limited");
    expect(issue.body).not.toContain("hidden");
  });

  it("excludes tools without enough recorded failure-pattern samples", async () => {
    const suffix = `${Date.now()}_threshold`;
    const oneFailureTool = `one_failure_${suffix}`;
    const twoFailureTool = `two_failures_${suffix}`;

    recordToolUsage([
      { id: "one", phase: "call", name: oneFailureTool, payload: { q: "x" } },
      { id: "one", phase: "result", name: oneFailureTool, payload: { error: "validation failed" } },
      { id: "two-a", phase: "call", name: twoFailureTool, payload: { q: "x" } },
      { id: "two-a", phase: "result", name: twoFailureTool, payload: { error: "validation failed" } },
      { id: "two-b", phase: "call", name: twoFailureTool, payload: { q: "y" } },
      { id: "two-b", phase: "result", name: twoFailureTool, payload: { error: "validation failed again" } },
    ], "");

    const issue = buildToolTelemetryComplaintIssue({
      tool_names: [oneFailureTool, twoFailureTool],
      min_failure_count: 2,
    });

    expect(issue.tools).toEqual([twoFailureTool]);
    expect(issue.body).toContain(`### ${twoFailureTool}`);
    expect(issue.body).not.toContain(`### ${oneFailureTool}`);
  });

  it("drafts by default instead of creating a GitHub issue", async () => {
    const out = JSON.parse(String(await reportToolTelemetryIssueTool.invoke({ tool_names: ["missing_tool"] })));

    expect(out).toMatchObject({ ok: true, created: false, owner: "CircuitWall", repo: "jarela" });
    expect(out.issue.title).toContain("Tool telemetry complaint");
    expect(out.hint).toContain("create_issue=true");
  });

  it("skips automatic filing when GitHub auth is absent", async () => {
    const result = await maybeAutoFileToolTelemetryIssue(new Date("2026-08-30T00:00:00.000Z"));

    expect(result).toEqual({ skipped: true, reason: "github_token_missing" });
  });

  it("auto-files once per new telemetry fingerprint", async () => {
    process.env.GH_TOKEN = "ghp_test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ number: 123, html_url: "https://github.com/CircuitWall/jarela/issues/123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const toolName = `auto_bad_tool_${Date.now()}`;
    recordToolUsage([
      { id: "auto", phase: "call", name: toolName, payload: { query: "boom" } },
      { id: "auto", phase: "result", name: toolName, payload: { error: "timeout while running" } },
      { id: "auto-2", phase: "call", name: toolName, payload: { query: "boom again" } },
      { id: "auto-2", phase: "result", name: toolName, payload: { error: "timeout while running again" } },
    ], "");

    const first = await maybeAutoFileToolTelemetryIssue(new Date("2026-08-30T00:00:00.000Z"), { failureThreshold: 2, minFailureCount: 2 });
    const second = await maybeAutoFileToolTelemetryIssue(new Date("2026-09-01T00:00:00.000Z"), { failureThreshold: 2, minFailureCount: 2 });

    expect(first.skipped).toBe(false);
    expect(first.github).toMatchObject({ ok: true, number: 123 });
    expect(first.metric?.metric).toBe("tool_failure_patterns_total");
    expect(second).toMatchObject({ skipped: true, reason: "threshold_already_reported" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getFingerprint("tool-telemetry-issues", "last-filed")).toBe(first.issue?.fingerprint);
  });

  it("skips automatic filing until the internal metric threshold is crossed", async () => {
    process.env.GH_TOKEN = "ghp_test";

    const result = await maybeAutoFileToolTelemetryIssue(new Date("2026-10-01T00:00:00.000Z"), { failureThreshold: 100_000 });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("threshold_not_met");
    expect(result.metric?.metric).toBe("tool_failure_patterns_total");
  });
});
