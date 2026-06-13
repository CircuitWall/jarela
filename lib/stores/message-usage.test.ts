import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-message-usage-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { recordMessageUsage, getMessageUsageByIds } = await import("./message-usage");
const getMessageUsage = (id: string) => getMessageUsageByIds([id]).get(id) ?? null;

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

  it("persists snapshot-only rows where the provider didn't report usage (cost=0)", () => {
    // Regression: cost_usd is NOT NULL in the schema, so a `null` fallback
    // silently swallowed every snapshot-only insert and the per-turn
    // context-usage bar never rendered. Default to 0 instead.
    recordMessageUsage({
      message_id: "m-snapshot-only",
      thread_id: "t-snap",
      agent_id: "agent-x",
      agent_name: "X",
      provider: "github-copilot",
      model_id: "claude-opus-4.7",
      model_config_name: "X-Opus",
      input_tokens: 0,
      output_tokens: 0,
      input_rate_usd_per_mtok: null,
      output_rate_usd_per_mtok: null,
      cost_usd: 0,
      tier_usage: {
        hot_tokens: 1234,
        warm_tokens: 0,
        facts_tokens: 56,
        overhead_tokens: 789,
        hot_budget_tokens: 120_000,
        warm_budget_tokens: 40_000,
        facts_budget_tokens: 20_000,
        context_window_tokens: 200_000,
      },
    });
    const row = getMessageUsage("m-snapshot-only");
    expect(row).not.toBeNull();
    expect(row?.cost_usd).toBe(0);
    expect(row?.input_tokens).toBe(0);
    // Tier breakdown survived the snapshot-only path.
    expect(row?.hot_tokens).toBe(1234);
    expect(row?.facts_tokens).toBe(56);
    expect(row?.context_window_tokens).toBe(200_000);
  });

  it("persists per-tier breakdown when tier_usage is provided", () => {
    recordMessageUsage({
      message_id: "m-tier",
      thread_id: "t-tier",
      agent_id: "a", agent_name: "A",
      provider: "anthropic", model_id: "claude-sonnet-4", model_config_name: null,
      input_tokens: 5000, output_tokens: 800,
      input_rate_usd_per_mtok: 3, output_rate_usd_per_mtok: 15,
      cost_usd: 0.027,
      tier_usage: {
        hot_tokens: 3000,
        warm_tokens: 1500,
        facts_tokens: 400,
        overhead_tokens: 100,
        hot_budget_tokens: 60_000,
        warm_budget_tokens: 20_000,
        facts_budget_tokens: 10_000,
        context_window_tokens: 100_000,
      },
    });
    const row = getMessageUsage("m-tier");
    expect(row?.hot_tokens).toBe(3000);
    expect(row?.warm_tokens).toBe(1500);
    expect(row?.facts_tokens).toBe(400);
    expect(row?.overhead_tokens).toBe(100);
    expect(row?.hot_budget_tokens).toBe(60_000);
    expect(row?.warm_budget_tokens).toBe(20_000);
    expect(row?.facts_budget_tokens).toBe(10_000);
    expect(row?.context_window_tokens).toBe(100_000);
  });

  it("stores NULL tier columns for legacy rows that omit tier_usage", () => {
    recordMessageUsage({
      message_id: "m-legacy",
      thread_id: "t-legacy",
      agent_id: "a", agent_name: "A",
      provider: "openai", model_id: "gpt-5", model_config_name: null,
      input_tokens: 10, output_tokens: 20,
      input_rate_usd_per_mtok: null, output_rate_usd_per_mtok: null,
      cost_usd: 0,
    });
    const row = getMessageUsage("m-legacy");
    expect(row).not.toBeNull();
    expect(row?.hot_tokens).toBeNull();
    expect(row?.warm_tokens).toBeNull();
    expect(row?.facts_tokens).toBeNull();
    expect(row?.overhead_tokens).toBeNull();
    expect(row?.hot_budget_tokens).toBeNull();
    expect(row?.warm_budget_tokens).toBeNull();
    expect(row?.facts_budget_tokens).toBeNull();
    expect(row?.context_window_tokens).toBeNull();
  });

  it("treats explicit `tier_usage: null` the same as omitted", () => {
    recordMessageUsage({
      message_id: "m-null-tier",
      thread_id: "t-legacy",
      agent_id: "a", agent_name: "A",
      provider: "openai", model_id: "gpt-5", model_config_name: null,
      input_tokens: 1, output_tokens: 1,
      input_rate_usd_per_mtok: null, output_rate_usd_per_mtok: null,
      cost_usd: 0,
      tier_usage: null,
    });
    const row = getMessageUsage("m-null-tier");
    expect(row?.hot_tokens).toBeNull();
    expect(row?.context_window_tokens).toBeNull();
  });

  it("INSERT OR IGNORE keeps the original tier breakdown on retry", () => {
    recordMessageUsage({
      message_id: "m-tier-retry",
      thread_id: "t-retry",
      agent_id: "a", agent_name: "A",
      provider: "anthropic", model_id: "claude-sonnet-4", model_config_name: null,
      input_tokens: 100, output_tokens: 50,
      input_rate_usd_per_mtok: 3, output_rate_usd_per_mtok: 15,
      cost_usd: 0.001,
      tier_usage: {
        hot_tokens: 60, warm_tokens: 30, facts_tokens: 5, overhead_tokens: 5,
        hot_budget_tokens: 1000, warm_budget_tokens: 500, facts_budget_tokens: 100,
        context_window_tokens: 2000,
      },
    });
    // Replay must not overwrite tier columns either.
    recordMessageUsage({
      message_id: "m-tier-retry",
      thread_id: "t-retry",
      agent_id: "a", agent_name: "A",
      provider: "anthropic", model_id: "claude-sonnet-4", model_config_name: null,
      input_tokens: 9999, output_tokens: 9999,
      input_rate_usd_per_mtok: 3, output_rate_usd_per_mtok: 15,
      cost_usd: 9.99,
      tier_usage: {
        hot_tokens: 9999, warm_tokens: 9999, facts_tokens: 9999, overhead_tokens: 9999,
        hot_budget_tokens: 9999, warm_budget_tokens: 9999, facts_budget_tokens: 9999,
        context_window_tokens: 9999,
      },
    });
    const row = getMessageUsage("m-tier-retry");
    expect(row?.input_tokens).toBe(100);
    expect(row?.hot_tokens).toBe(60);
    expect(row?.context_window_tokens).toBe(2000);
  });

  it("getMessageUsage returns null for unknown ids", () => {
    expect(getMessageUsage("does-not-exist")).toBeNull();
  });

  it("getMessageUsageByIds returns a map keyed by message_id, skipping unknowns", () => {
    const map = getMessageUsageByIds(["m1", "m2", "m-tier", "m-missing"]);
    expect(map.size).toBe(3);
    expect(map.get("m1")?.input_tokens).toBe(1200);
    expect(map.get("m2")?.input_tokens).toBe(10);
    expect(map.get("m-tier")?.hot_tokens).toBe(3000);
    expect(map.has("m-missing")).toBe(false);
  });

  it("getMessageUsageByIds returns an empty map for an empty input", () => {
    const map = getMessageUsageByIds([]);
    expect(map.size).toBe(0);
  });

  it("persists Anthropic cache_creation/cache_read token counts (PR #181 follow-up)", () => {
    recordMessageUsage({
      message_id: "m-cache",
      thread_id: "t-cache",
      agent_id: "a", agent_name: "A",
      provider: "anthropic", model_id: "claude-sonnet-4", model_config_name: null,
      input_tokens: 1200,
      output_tokens: 350,
      cache_creation_input_tokens: 4000,
      cache_read_input_tokens: 80_000,
      input_rate_usd_per_mtok: 3,
      output_rate_usd_per_mtok: 15,
      cost_usd: 0.04,
    });
    const row = getMessageUsage("m-cache");
    expect(row?.cache_creation_input_tokens).toBe(4000);
    expect(row?.cache_read_input_tokens).toBe(80_000);
  });

  it("stores NULL cache columns for legacy rows that omit them", () => {
    recordMessageUsage({
      message_id: "m-no-cache",
      thread_id: "t-no-cache",
      agent_id: "a", agent_name: "A",
      provider: "openai", model_id: "gpt-5", model_config_name: null,
      input_tokens: 10, output_tokens: 20,
      input_rate_usd_per_mtok: null, output_rate_usd_per_mtok: null,
      cost_usd: 0,
    });
    const row = getMessageUsage("m-no-cache");
    expect(row?.cache_creation_input_tokens).toBeNull();
    expect(row?.cache_read_input_tokens).toBeNull();
  });
});
