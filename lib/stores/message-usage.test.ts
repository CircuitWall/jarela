import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-message-usage-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { recordMessageUsage, getMessageUsage, computeCostUsd } = await import("./message-usage");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("message_usage snapshot store (ADR-0041)", () => {
  it("records and reads back a usage snapshot", () => {
    recordMessageUsage({
      message_id: "m1",
      thread_id: "t1",
      agent_id: "agent-alpha",
      agent_name: "Alpha",
      provider: "anthropic",
      model_id: "claude-sonnet-4",
      model_config_name: "alpha-sonnet",
      input_tokens: 1200,
      output_tokens: 350,
      input_rate_usd_per_mtok: 3.0,
      output_rate_usd_per_mtok: 15.0,
      cost_usd: (1200 / 1_000_000) * 3.0 + (350 / 1_000_000) * 15.0,
    });
    const row = getMessageUsage("m1");
    expect(row).not.toBeNull();
    expect(row?.input_tokens).toBe(1200);
    expect(row?.output_tokens).toBe(350);
    expect(row?.provider).toBe("anthropic");
    expect(row?.cost_usd).toBeGreaterThan(0);
  });

  it("INSERT OR IGNORE makes recording idempotent on retry", () => {
    recordMessageUsage({
      message_id: "m2", thread_id: "t1", agent_id: "a", agent_name: "A",
      provider: "openai", model_id: "gpt-5", model_config_name: null,
      input_tokens: 10, output_tokens: 20,
      input_rate_usd_per_mtok: null, output_rate_usd_per_mtok: null,
      cost_usd: 0,
    });
    // Second insert with different tokens must not overwrite.
    recordMessageUsage({
      message_id: "m2", thread_id: "t1", agent_id: "a", agent_name: "A",
      provider: "openai", model_id: "gpt-5", model_config_name: null,
      input_tokens: 9999, output_tokens: 9999,
      input_rate_usd_per_mtok: null, output_rate_usd_per_mtok: null,
      cost_usd: 999,
    });
    const row = getMessageUsage("m2");
    expect(row?.input_tokens).toBe(10);
    expect(row?.output_tokens).toBe(20);
  });

  it("computeCostUsd applies per-MTok rates correctly", () => {
    expect(computeCostUsd(1_000_000, 0, 3, 15)).toBeCloseTo(3, 6);
    expect(computeCostUsd(0, 1_000_000, 3, 15)).toBeCloseTo(15, 6);
    expect(computeCostUsd(500_000, 500_000, 3, 15)).toBeCloseTo(9, 6);
    expect(computeCostUsd(100, 100, null, null)).toBe(0);
  });
});
