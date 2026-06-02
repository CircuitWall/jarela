import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateWithTelemetry,
  getValidatorStats,
  recentValidatorEntries,
  _resetValidatorTelemetry,
} from "./telemetry";

describe("validateWithTelemetry — non-firing path", () => {
  beforeEach(() => {
    _resetValidatorTelemetry();
    delete process.env.JARELA_DISABLE_OUTPUT_VALIDATOR;
  });

  it("records ok=true when the validator passes", () => {
    const result = validateWithTelemetry(
      "stall_retry_check",
      "Just calling a tool now",
      ["jira_search"],
      ["jira_search"],
    );
    expect(result.ok).toBe(true);
    const stats = getValidatorStats();
    expect(stats.total).toBe(1);
    expect(stats.ok).toBe(1);
    expect(stats.hit_rate).toBe(0);
    expect(stats.by_stage.stall_retry_check).toBe(1);
  });
});

describe("validateWithTelemetry — firing paths", () => {
  beforeEach(() => {
    _resetValidatorTelemetry();
    delete process.env.JARELA_DISABLE_OUTPUT_VALIDATOR;
  });

  it("records claim_without_tool when text claims work but no tool fired", () => {
    const result = validateWithTelemetry(
      "stall_retry_check",
      "I've created the issue PROJ-42 for you.",
      [], // no tools called
      ["jira_create_issue"],
    );
    expect(result.ok).toBe(false);
    expect((result as { kind: string }).kind).toBe("claim_without_tool");
    const stats = getValidatorStats();
    expect(stats.by_kind.claim_without_tool).toBe(1);
    expect(stats.hit_rate).toBe(1);
  });

  it("records summary_without_action on a recap with no tool calls", () => {
    const result = validateWithTelemetry(
      "footer_check",
      "## Summary of changes\nI made the requested updates.",
      [],
      ["file_write"],
    );
    expect(result.ok).toBe(false);
    expect((result as { kind: string }).kind).toBe("summary_without_action");
    const stats = getValidatorStats();
    expect(stats.by_stage.footer_check).toBe(1);
  });

  it("emits a [validator] log line on fire", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      validateWithTelemetry(
        "stall_retry_check",
        "I've completed the task.",
        [],
        ["file_write"],
      );
      expect(spy).toHaveBeenCalled();
      const line = spy.mock.calls[0][0] as string;
      expect(line).toContain("[validator]");
      expect(line).toContain("stage=stall_retry_check");
      expect(line).toMatch(/kind=(claim_without_tool|summary_without_action)/);
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT log when validator passes (ok-path is silent)", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      validateWithTelemetry("stall_retry_check", "All good.", ["x"], ["x"]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("validateWithTelemetry — disabled flag", () => {
  beforeEach(() => {
    _resetValidatorTelemetry();
  });
  afterEach(() => {
    delete process.env.JARELA_DISABLE_OUTPUT_VALIDATOR;
  });

  it("short-circuits to ok=true when JARELA_DISABLE_OUTPUT_VALIDATOR=1", () => {
    process.env.JARELA_DISABLE_OUTPUT_VALIDATOR = "1";
    const result = validateWithTelemetry(
      "stall_retry_check",
      "I've created the issue PROJ-42 for you.", // would normally fire
      [],
      ["jira_create_issue"],
    );
    expect(result.ok).toBe(true);
  });

  it("still records the call (so disabled-period turns count toward stats)", () => {
    process.env.JARELA_DISABLE_OUTPUT_VALIDATOR = "1";
    validateWithTelemetry("stall_retry_check", "anything", [], []);
    const stats = getValidatorStats();
    expect(stats.total).toBe(1);
    expect(stats.disabled).toBe(true);
    expect(stats.ok).toBe(1);
  });
});

describe("ring buffer", () => {
  beforeEach(() => {
    _resetValidatorTelemetry();
    delete process.env.JARELA_DISABLE_OUTPUT_VALIDATOR;
  });

  it("recentValidatorEntries returns the requested slice", () => {
    for (let i = 0; i < 5; i += 1) {
      validateWithTelemetry("stall_retry_check", `call ${i}`, ["x"], ["x"]);
    }
    expect(recentValidatorEntries(2)).toHaveLength(2);
    expect(recentValidatorEntries()).toHaveLength(5);
  });

  it("hit_rate is non-zero when any fire is recorded", () => {
    validateWithTelemetry("stall_retry_check", "ok", ["x"], ["x"]);
    validateWithTelemetry("stall_retry_check", "I've completed it.", [], ["x"]);
    const stats = getValidatorStats();
    expect(stats.total).toBe(2);
    expect(stats.hit_rate).toBeGreaterThan(0);
    expect(stats.hit_rate).toBeLessThanOrEqual(1);
  });
});
