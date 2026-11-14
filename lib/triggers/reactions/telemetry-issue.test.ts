import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeAutoFile: vi.fn(),
  currentMetric: vi.fn((_threshold?: number) => ({
    metric: "tool_failure_patterns_total",
    value: 45,
    threshold: 500,
    bucket: 0,
    previous_bucket: 0,
  })),
}));

vi.mock("@/lib/tools/system/tool-telemetry-issue", () => ({
  maybeAutoFileToolTelemetryIssue: mocks.maybeAutoFile,
  currentToolFailureMetric: mocks.currentMetric,
}));

const { getScript, listReactionScripts } = await import("@/lib/triggers/scripts");
// Side-effect import registers the script for the whole file.
await import("./telemetry-issue");

const SCRIPT = "reaction.telemetry_issue";

function run(args: Record<string, unknown> = {}) {
  const fn = getScript(SCRIPT);
  if (!fn) throw new Error("script not registered");
  return fn(args);
}

beforeEach(() => {
  mocks.maybeAutoFile.mockReset();
  mocks.currentMetric.mockClear();
});

describe("reaction.telemetry_issue", () => {
  it("is registered as a user-attachable reaction script", () => {
    expect(listReactionScripts()).toContain(SCRIPT);
  });

  it("files under the default +500 threshold and reports the issue number", async () => {
    mocks.maybeAutoFile.mockResolvedValue({
      skipped: false,
      github: { ok: true, number: 812, url: "https://github.com/CircuitWall/jarela/issues/812" },
      metric: {
        metric: "tool_failure_patterns_total",
        value: 512,
        threshold: 500,
        bucket: 1,
        previous_bucket: 0,
      },
    });

    const { preview } = await run();

    expect(preview).toContain("#812");
    expect(preview).toContain("512 failure patterns");
    expect(mocks.maybeAutoFile).toHaveBeenCalledWith(expect.any(Date), {
      failureThreshold: 500,
      minFailureCount: 2,
    });
  });

  it("maps failure_threshold / min_failure_count args onto the check", async () => {
    mocks.maybeAutoFile.mockResolvedValue({ skipped: true, reason: "threshold_not_met" });

    await run({ failure_threshold: 250, min_failure_count: 4 });

    expect(mocks.maybeAutoFile).toHaveBeenCalledWith(expect.any(Date), {
      failureThreshold: 250,
      minFailureCount: 4,
    });
  });

  it("reports a below-threshold run without throwing", async () => {
    mocks.maybeAutoFile.mockResolvedValue({
      skipped: true,
      reason: "threshold_not_met",
      metric: {
        metric: "tool_failure_patterns_total",
        value: 45,
        threshold: 500,
        bucket: 0,
        previous_bucket: 0,
      },
    });

    const { preview } = await run();

    expect(preview).toContain("threshold_not_met");
    expect(preview).toContain("45 failure patterns");
    expect(preview).not.toContain("#");
  });

  it("surfaces the missing-token skip with actionable guidance", async () => {
    mocks.maybeAutoFile.mockResolvedValue({ skipped: true, reason: "github_token_missing" });

    const { preview } = await run();

    expect(preview).toContain("github_token_missing");
    expect(preview).toContain("GITHUB_TOKEN");
  });

  it("reports a filing whose issue number was not returned", async () => {
    mocks.maybeAutoFile.mockResolvedValue({
      skipped: false,
      github: { ok: true, number: null, url: "https://github.com/CircuitWall/jarela/issues/999" },
    });

    const { preview } = await run();

    expect(preview).toContain("filed issue (number unavailable)");
  });

  it("throws when the check cannot be run, so the firing is marked failed", async () => {
    mocks.maybeAutoFile.mockRejectedValue(new Error("db locked"));

    await expect(run()).rejects.toThrow("telemetry threshold check failed: db locked");
  });

  it("throws when the GitHub filing attempt failed", async () => {
    mocks.maybeAutoFile.mockResolvedValue({
      skipped: true,
      reason: "github_create_failed",
      github: { ok: false, error: "GitHub 401: Bad credentials" },
    });

    await expect(run()).rejects.toThrow("telemetry issue filing failed: GitHub 401");
  });
});
