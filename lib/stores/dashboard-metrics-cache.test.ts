import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-dashboard-cache-"));
process.env.JARELA_DB_DIR = tmpRoot;
const { getDb, closeDb, DB_PATH } = await import("@/lib/db");
const { getDashboardMetrics } = await import("./dashboard-metrics");
const { recordMessageUsage } = await import("./message-usage");
const { getPricingTables } = await import("./pricing");
const pricing = await import("./pricing");

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM message_usage; DELETE FROM messages; DELETE FROM threads;");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO threads(thread_id, agent_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run("t1", "a1", now, now);
  db.prepare("INSERT INTO messages(msg_id, thread_id, role, content, created_at) VALUES (?,?,?,?,?)")
    .run("m1", "t1", "assistant", "  legacy estimate  ", now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("dashboard metrics cache", () => {
  it("reuses a result only while the data, pricing, and window are unchanged", async () => {
    const first = await getDashboardMetrics(30);
    expect(await getDashboardMetrics(30)).toBe(first);
    expect(first.summary.output_tokens_est).toBe(4);
    expect(await getDashboardMetrics(7)).not.toBe(first);
  });

  it("invalidates immediately after local writes", async () => {
    const first = await getDashboardMetrics();
    getDb().prepare("UPDATE messages SET content=? WHERE msg_id=?").run("a".repeat(100), "m1");
    const next = await getDashboardMetrics();
    expect(next).not.toBe(first);
    expect(next.summary.output_tokens_est).toBe(25);
  });

  it("invalidates for writes through another connection", async () => {
    const first = await getDashboardMetrics();
    const writer = new DatabaseSync(DB_PATH);
    try {
      writer.prepare("UPDATE messages SET content=? WHERE msg_id=?").run("b".repeat(80), "m1");
      const next = await getDashboardMetrics();
      expect(next).not.toBe(first);
      expect(next.summary.output_tokens_est).toBe(20);
    } finally {
      writer.close();
    }
  });

  it("expires after five seconds and across UTC day boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T23:59:59.000Z"));
    const first = await getDashboardMetrics();
    vi.setSystemTime(new Date("2026-10-19T00:00:00.000Z"));
    const nextDay = await getDashboardMetrics();
    expect(nextDay).not.toBe(first);
    vi.advanceTimersByTime(5000);
    expect(await getDashboardMetrics()).not.toBe(nextDay);
  });

  it("invalidates when pricing tables change", async () => {
    const first = await getDashboardMetrics();
    const tables = getPricingTables();
    vi.spyOn(pricing, "getPricingTables").mockReturnValue({ ...tables });
    expect(await getDashboardMetrics()).not.toBe(first);
  });

  it("preserves snapshot tokens, costs, and tool counts without needing the body", async () => {
    getDb().prepare("UPDATE messages SET content=?, tool_events=? WHERE msg_id='m1'")
      .run("x".repeat(100_000), JSON.stringify([
        { id: "call1", phase: "call", name: "test", payload: {} },
        { id: "call1", phase: "result", name: "test", payload: { ok: true } },
      ]));
    recordMessageUsage({
      message_id: "m1", thread_id: "t1", agent_id: "a1", agent_name: "Synthetic",
      provider: "synthetic", model_id: "synthetic", model_config_name: null,
      input_tokens: 100, output_tokens: 20, input_rate_usd_per_mtok: null,
      output_rate_usd_per_mtok: null, cost_usd: 0.5,
    });
    const data = await getDashboardMetrics();
    expect(data.summary).toMatchObject({
      input_tokens_est: 100, output_tokens_est: 20,
      recorded_cost_usd: 0.5, tool_calls: 1, tool_successes: 1,
    });
    expect(data.summary.data_quality.measured_messages).toBe(1);
    expect(data.summary.cost_breakdown).toEqual({
      input_cost_usd: 0, output_cost_usd: 0, unattributed_cost_usd: 0.5,
    });
  });

  it("aggregates unequal input/output costs consistently across every dashboard scope", async () => {
    const rates = {
      inputPer1M: 2, outputPer1M: 8, source: "synthetic", inferred: false,
      confidence: "high" as const, ok: true, status: 200, error: null,
    };
    vi.spyOn(pricing, "getPricingTables").mockReturnValue({
      byProvider: new Map([["synthetic", rates]]),
      byProviderModel: new Map([["synthetic::test-model", rates]]),
      byModel: new Map([["test-model", rates]]),
      aggregatorSources: [], aggregatorModelRates: [], generatedAt: null,
    });
    recordMessageUsage({
      message_id: "m1", thread_id: "t1", agent_id: "a1", agent_name: "Synthetic",
      provider: "synthetic", model_id: "test-model", model_config_name: "Synthetic",
      input_tokens: 1_000_000, output_tokens: 250_000, input_rate_usd_per_mtok: 2,
      output_rate_usd_per_mtok: 8, cost_usd: 99,
    });
    const now = new Date().toISOString();
    getDb().prepare("INSERT INTO messages(msg_id, thread_id, role, content, created_at) VALUES (?,?,?,?,?)")
      .run("m2", "t1", "assistant", "synthetic", now);
    recordMessageUsage({
      message_id: "m2", thread_id: "t1", agent_id: "a1", agent_name: "Synthetic",
      provider: "synthetic", model_id: "test-model", model_config_name: "Synthetic",
      input_tokens: 500_000, output_tokens: 500_000, input_rate_usd_per_mtok: 2,
      output_rate_usd_per_mtok: 8, cost_usd: 50,
    });
    const data = await getDashboardMetrics();
    const day = data.breakdowns_by_day[now.slice(0, 10)];
    for (const row of [
      data.summary, data.by_provider[0], data.by_model[0], data.top_agents[0],
      data.series.find((point) => point.day === day.day)!,
      day.summary, day.by_provider[0], day.by_model[0], day.top_agents[0],
    ]) {
      expect(row.cost_breakdown).toEqual({ input_cost_usd: 3, output_cost_usd: 6, unattributed_cost_usd: 0 });
      expect(row.estimated_cost_usd).toBe(9);
    }
    expect(data.summary.recorded_cost_usd).toBe(149);
    expect(data.series.filter((point) => point.day !== day.day).every((point) =>
      Object.values(point.cost_breakdown).every((cost) => cost === 0))).toBe(true);
  });

  it.each([0, 100])("suppresses user estimates only for provider-token snapshots: %s", async (inputTokens) => {
    const now = new Date().toISOString();
    getDb().prepare("INSERT INTO messages(msg_id, thread_id, role, content, created_at) VALUES (?,?,?,?,?)")
      .run("user-estimate", "t1", "user", "u".repeat(80), now);
    recordMessageUsage({
      message_id: "m1", thread_id: "t1", agent_id: "captured-agent", agent_name: "Captured Agent",
      provider: "synthetic", model_id: "captured-model", model_config_name: "Captured Config",
      input_tokens: inputTokens, output_tokens: 10, input_rate_usd_per_mtok: null,
      output_rate_usd_per_mtok: null, cost_usd: 0.5, cache_read_input_tokens: 5,
      tier_usage: {
        hot_tokens: 4, warm_tokens: 3, facts_tokens: 2, overhead_tokens: 1,
        hot_budget_tokens: 10, warm_budget_tokens: 10, facts_budget_tokens: 10, context_window_tokens: 100,
      },
    });
    const data = await getDashboardMetrics();
    const day = data.breakdowns_by_day[now.slice(0, 10)];
    expect(data.summary.input_tokens_est).toBe(inputTokens > 0 ? inputTokens : 20);
    expect(data.summary.output_tokens_est).toBe(10);
    expect(data.summary.cache_read_tokens).toBe(5);
    expect(data.summary.data_quality).toEqual({ measured_messages: 1, estimated_messages: 0, measured_pct: 1 });
    expect(data.summary.tier_tokens).toEqual({
      hot_tokens: 4, warm_tokens: 3, facts_tokens: 2, overhead_tokens: 1, measured_input_tokens: 10,
    });
    expect(day.summary.input_tokens_est).toBe(data.summary.input_tokens_est);
    expect(day.summary.tier_tokens).toEqual(data.summary.tier_tokens);
    for (const buckets of [data.by_provider, data.by_model, data.top_agents, day.by_provider, day.by_model, day.top_agents]) {
      expect(buckets.reduce((sum, bucket) => sum + bucket.input_tokens_est, 0)).toBe(data.summary.input_tokens_est);
      expect(buckets.reduce((sum, bucket) => sum + bucket.message_count, 0)).toBe(2);
    }
    expect(data.top_agents).toContainEqual(expect.objectContaining({
      agent_id: "captured-agent", agent_name: "Captured Agent", output_tokens_est: 10,
    }));
    expect(data.by_model).toContainEqual(expect.objectContaining({
      model_id: "captured-model", model_config_name: "Captured Config", output_tokens_est: 10,
    }));
  });
});
