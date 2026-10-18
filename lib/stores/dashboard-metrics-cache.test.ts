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
  });
});
