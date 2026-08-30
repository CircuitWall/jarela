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
    ], "");

    const first = await maybeAutoFileToolTelemetryIssue(new Date("2026-08-30T00:00:00.000Z"));
    const second = await maybeAutoFileToolTelemetryIssue(new Date("2026-09-01T00:00:00.000Z"));

    expect(first.skipped).toBe(false);
    expect(first.github).toMatchObject({ ok: true, number: 123 });
    expect(second).toMatchObject({ skipped: true, reason: "already_filed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getFingerprint("tool-telemetry-issues", "last-filed")).toBe(first.issue?.fingerprint);
  });
});
